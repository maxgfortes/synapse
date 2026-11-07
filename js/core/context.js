// Coleta o contexto real: hora, localizacao aproximada, clima e feriados.
// As coordenadas sao arredondadas (cerca de 10 km) antes de qualquer uso.

import { buildContext, weatherClass } from '../metis/context.js';
import { db } from './db.js';
import { bus } from './bus.js';

const WEATHER_TTL = 30 * 6e4;
const round1 = (x) => Math.round(x * 10) / 10;

export const WEATHER_LABEL = {
  clear: 'Céu limpo', cloudy: 'Nublado', fog: 'Neblina', rain: 'Chuva', storm: 'Tempestade', snow: 'Neve',
};

class ContextService {
  constructor() {
    this.weather = null;
    this.place = null;
    this.holidays = {};
    this.consent = 'unset'; // unset | granted | denied
    this.session = { start: Date.now(), last: 0, depth: 0, recentSkips: 0 };
    this.volume = 0.8;
    this.history = { temps: [] };
  }

  async init() {
    this.consent = await db.getKV('geoConsent', 'unset');
    this.place = await db.getKV('place', null);
    this.weather = await db.getKV('weather', null);
    this.holidays = await db.getKV('holidays', {});
    this.history = await db.getKV('weatherHistory', { temps: [] });
    this.home = await db.getKV('homePlaces', {});
    if (this.consent === 'granted') this.refresh();
    setInterval(() => this.refresh(), WEATHER_TTL);
  }

  async requestLocation() {
    if (!navigator.geolocation) {
      await this.setConsent('denied');
      return false;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          await this.setConsent('granted');
          await this._applyPosition(position.coords.latitude, position.coords.longitude);
          resolve(true);
        },
        async () => {
          await this.setConsent('denied');
          resolve(false);
        },
        { maximumAge: 30 * 6e4, timeout: 12000, enableHighAccuracy: false },
      );
    });
  }

  async setConsent(value) {
    this.consent = value;
    await db.setKV('geoConsent', value);
    if (value === 'denied') {
      this.place = null;
      await db.setKV('place', null);
    }
    bus.emit('context');
  }

  async _applyPosition(lat, lon) {
    const rLat = round1(lat);
    const rLon = round1(lon);
    const id = `${rLat},${rLon}`;
    let city = this.place?.id === id ? this.place.city : null;
    let country = this.place?.id === id ? this.place.country : null;
    if (!city) {
      try {
        const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${rLat}&longitude=${rLon}&localityLanguage=pt`);
        const data = await response.json();
        city = data.city || data.locality || data.principalSubdivision || null;
        country = data.countryCode || null;
      } catch { /* cidade e so um rotulo */ }
    }
    // Lugar mais frequente vira "casa"; o resto conta como fora de casa.
    this.home[id] = (this.home[id] || 0) + 1;
    const top = Object.entries(this.home).sort((a, b) => b[1] - a[1])[0]?.[0];
    this.place = { id, lat: rLat, lon: rLon, city, country, away: top !== id };
    await db.setKV('place', this.place);
    await db.setKV('homePlaces', this.home);
    await this._fetchWeather();
    if (country) await this._fetchHolidays(country);
    bus.emit('context');
  }

  async refresh() {
    if (this.consent !== 'granted' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => this._applyPosition(p.coords.latitude, p.coords.longitude),
      () => { if (this.place) this._fetchWeather(); },
      { maximumAge: 30 * 6e4, timeout: 12000 },
    );
  }

  async _fetchWeather() {
    if (!this.place || !navigator.onLine) return;
    if (this.weather && Date.now() - this.weather.fetchedAt < WEATHER_TTL * 0.9 && this.weather.placeId === this.place.id) return;
    try {
      const params = new URLSearchParams({
        latitude: this.place.lat,
        longitude: this.place.lon,
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,precipitation,wind_speed_10m,weather_code,is_day',
        daily: 'sunrise,sunset',
        forecast_days: '1',
        timeformat: 'unixtime',
        timezone: 'auto',
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!response.ok) return;
      const data = await response.json();
      const c = data.current;
      // Anomalia: quanto esta mais quente ou frio que a media dos ultimos dias.
      const temps = this.history.temps;
      temps.push({ ts: Date.now(), t: c.temperature_2m });
      const cutoff = Date.now() - 14 * 864e5;
      this.history.temps = temps.filter((x) => x.ts > cutoff).slice(-400);
      const avg = this.history.temps.reduce((s, x) => s + x.t, 0) / this.history.temps.length;
      this.weather = {
        fetchedAt: Date.now(),
        placeId: this.place.id,
        kind: weatherClass(c.weather_code),
        code: c.weather_code,
        temp: c.temperature_2m,
        apparent: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        cloud: c.cloud_cover,
        precip: c.precipitation,
        wind: c.wind_speed_10m,
        anomaly: c.temperature_2m - avg,
        sunrise: (data.daily?.sunrise?.[0] ?? 0) * 1000 || null,
        sunset: (data.daily?.sunset?.[0] ?? 0) * 1000 || null,
      };
      await db.setKV('weather', this.weather);
      await db.setKV('weatherHistory', this.history);
      bus.emit('context');
    } catch { /* offline: mantem o ultimo clima conhecido */ }
  }

  async _fetchHolidays(country) {
    const year = new Date().getFullYear();
    const key = `${country}-${year}`;
    if (this.holidays[key]) return;
    try {
      const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
      if (!response.ok) return;
      this.holidays[key] = (await response.json()).map((h) => h.date);
      await db.setKV('holidays', this.holidays);
    } catch { /* feriado e opcional */ }
  }

  _isHoliday(date) {
    if (!this.place?.country) return false;
    const key = `${this.place.country}-${date.getFullYear()}`;
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return (this.holidays[key] || []).includes(today);
  }

  // Sessao nova apos 30 minutos sem ouvir nada.
  touchSession(skipped = false) {
    const now = Date.now();
    const s = this.session;
    if (now - s.last > 30 * 6e4) {
      s.start = now;
      s.depth = 0;
      s.recentSkips = 0;
    }
    s.last = now;
    s.depth += 1;
    s.recentSkips = skipped ? s.recentSkips + 1 : Math.max(0, s.recentSkips - 0.5);
  }

  now() {
    const date = new Date();
    const s = this.session;
    const stale = this.weather && Date.now() - this.weather.fetchedAt > 6 * 36e5;
    return buildContext({
      date,
      weather: stale ? null : this.weather,
      place: this.place,
      holiday: this._isHoliday(date),
      session: {
        minutes: (date.getTime() - s.start) / 6e4,
        depth: s.depth,
        recentSkips: s.recentSkips,
      },
      device: {
        mobile: matchMedia('(pointer: coarse)').matches,
        online: navigator.onLine,
        visible: document.visibilityState === 'visible',
        volume: this.volume,
      },
    });
  }
}

export const contextService = new ContextService();

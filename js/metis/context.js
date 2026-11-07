// Transforma momento, clima e sessao em um vetor numerico. Funcao pura:
// quem busca GPS e clima e js/core/context.js.

import { clamp } from './math.js';

export const WEATHER_CLASSES = ['clear', 'cloudy', 'fog', 'rain', 'storm', 'snow'];

// Codigos WMO usados pelo Open-Meteo.
export function weatherClass(code) {
  if (code == null) return null;
  if (code <= 1) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code <= 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

function dayOfYear(date) {
  return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 864e5);
}

// 0 verao, 1 outono, 2 inverno, 3 primavera, respeitando o hemisferio.
export function seasonOf(date, lat) {
  const m = date.getMonth();
  const north = m >= 5 && m <= 7 ? 0 : m >= 8 && m <= 10 ? 1 : m === 11 || m <= 1 ? 2 : 3;
  return lat != null && lat < 0 ? (north + 2) % 4 : north;
}

export function buildContext({ date = new Date(), weather = null, place = null, session = {}, device = {}, holiday = false } = {}) {
  const hour = date.getHours() + date.getMinutes() / 60;
  const dow = date.getDay();
  const doy = dayOfYear(date);
  let daylight = hour >= 6.5 && hour < 18.5 ? 1 : 0;
  if (weather?.sunrise != null && weather?.sunset != null) {
    const ts = date.getTime();
    const edge = 45 * 6e4;
    daylight = clamp(Math.min(ts - weather.sunrise + edge, weather.sunset - ts + edge) / (2 * edge));
  }
  return {
    ts: date.getTime(),
    hour,
    dow,
    doy,
    weekend: dow === 0 || dow === 6,
    season: seasonOf(date, place?.lat),
    daylight,
    holiday: !!holiday,
    weather: weather?.kind ?? null,
    temp: weather?.temp ?? null,
    apparent: weather?.apparent ?? null,
    tempAnomaly: weather?.anomaly ?? 0,
    humidity: weather?.humidity ?? null,
    cloud: weather?.cloud ?? null,
    wind: weather?.wind ?? null,
    precip: weather?.precip ?? 0,
    placeId: place?.id ?? null,
    city: place?.city ?? null,
    away: !!place?.away,
    mobile: !!device.mobile,
    online: device.online !== false,
    visible: device.visible !== false,
    volume: device.volume ?? 0.8,
    sessionMinutes: session.minutes ?? 0,
    sessionDepth: session.depth ?? 0,
    recentSkips: session.recentSkips ?? 0,
  };
}

const TAU = 2 * Math.PI;

export const CONTEXT_DIM = 24;

export function contextVector(c) {
  const temp = c.temp == null ? 0.5 : clamp((c.temp + 5) / 45);
  const known = c.weather ? 1 : 0;
  const is = (kind) => (c.weather === kind ? 1 : 0);
  return Float64Array.from([
    Math.sin((TAU * c.hour) / 24), Math.cos((TAU * c.hour) / 24),
    Math.sin((TAU * c.dow) / 7), Math.cos((TAU * c.dow) / 7),
    Math.sin((TAU * c.doy) / 366), Math.cos((TAU * c.doy) / 366),
    c.weekend ? 1 : 0, c.holiday ? 1 : 0, c.daylight,
    known, is('clear'), is('cloudy'), is('fog'), is('rain'), is('storm'), is('snow'),
    temp, clamp((c.tempAnomaly || 0) / 12, -1, 1),
    c.humidity == null ? 0.5 : c.humidity / 100,
    c.wind == null ? 0.2 : clamp(c.wind / 50),
    c.mobile ? 1 : 0, c.away ? 1 : 0,
    clamp((c.sessionMinutes || 0) / 120),
    clamp((c.recentSkips || 0) / 5),
  ]);
}

// Faixas suaves do dia para os cruzamentos do modelo. Somam 1.
export function dayparts(hour) {
  const bump = (center, width) => {
    const d = 12 - Math.abs(((hour - center + 36) % 24) - 12);
    return Math.exp(-0.5 * ((12 - d) / width) ** 2);
  };
  const raw = [bump(8, 2.6), bump(14, 2.8), bump(20, 2.4), bump(2, 2.8)];
  const total = raw[0] + raw[1] + raw[2] + raw[3] || 1;
  return raw.map((x) => x / total);
}

// Versao compacta para a memoria por kernel. Cada dimensao tem peso proprio:
// a hora conta mais que a estacao.
export function compactContext(c) {
  const temp = c.temp == null ? 0.5 : clamp((c.temp + 5) / 45);
  return [
    1.4 * Math.sin((TAU * c.hour) / 24), 1.4 * Math.cos((TAU * c.hour) / 24),
    c.weekend ? 0.7 : 0,
    c.daylight * 0.6,
    (c.weather === 'rain' || c.weather === 'storm') ? 1 : 0,
    c.weather === 'clear' ? 0.6 : 0,
    temp * 0.8,
    0.3 * Math.sin((TAU * c.doy) / 366), 0.3 * Math.cos((TAU * c.doy) / 366),
    c.away ? 0.5 : 0,
  ].map((x) => Math.round(x * 1000) / 1000);
}

# Synapse

Player de música com ordem inteligente. O **Metís** estima o clima do ouvinte com hora, tempo lá fora e histórico, e cria uma sequência infinita que aprende no próprio aparelho.

PWA estático, sem build e sem dependências. Visual de iTunes 12 no desktop e do app Música do iOS no celular, em preto sólido.

## Rodar

```bash
npm start
```

Abre em `http://localhost:5177`. Service worker e geolocalização exigem `localhost` ou HTTPS.

```bash
npm test
```

## Publicar no GitHub Pages

Envie esta pasta para `github.com/maxgfortes/synapse` e ative o Pages na branch principal. O `.nojekyll` já está aqui.

Em outro endereço, troque `maxgfortes.github.io/synapse` em `js/config.js`, `index.html`, `sobre.html`, `termos.html`, `contato.html`, `404.html`, `robots.txt` e `sitemap.xml`.

Ao publicar uma versão nova, aumente `VERSION` em `sw.js`. Para refazer imagens: `node tools/make-assets.mjs`. Para mudar os ícones da interface: edite o mapa em `tools/make-icons.mjs` e rode esse script.

## Busca do YouTube

A busca usa a YouTube Data API v3 quando há uma chave em `js/config.js` ou em Preferências. O repositório não traz chave: a de `js/config.js` fica visível no código do site, então só deve ser preenchida com uma chave restrita por domínio no Google Cloud. Cada busca gasta 100 unidades de uma cota diária de 10.000, ou seja, cerca de 100 buscas por dia para todos os usuários somados. Quando a cota acaba, a busca passa para um espelho público (Piped), que pode sair do ar. Cada usuário também pode colar a própria chave em Preferências.

A API entrega busca e metadados, não o áudio. O áudio vem do player oficial do YouTube, que fica atrás da interface: o usuário só vê o player do Synapse. Se um vídeo estiver bloqueado para reprodução externa ou tiver sido removido, o app procura outra versão da mesma música e troca sozinho, gastando mais 100 unidades.

Colar links funciona sempre.

## Como o Metís funciona

| Peça | Arquivo | Papel |
| --- | --- | --- |
| Contexto | `js/metis/context.js` | Hora, dia, estação, feriado, luz do dia, clima, lugar, sessão |
| Som | `js/metis/dsp.js` | BPM, graves, agudos, pitch, tom, energia e dinâmica, em um Web Worker |
| Faixa | `js/metis/features.js` | Vetor de cada música, gênero como reserva, similaridade, distância harmônica |
| Rede | `js/metis/nn.js` | Wide & Deep com backprop próprio, treinada on-line, prevê se a música vai até o fim |
| Motor | `js/metis/engine.js` | Estado emocional, memória por kernel, onda e sorteio |

Uma escolha soma: proximidade do clima alvo, transição com a anterior, descanso, espaçamento de artistas, Thompson sampling, memória, regressão por kernel e rede. O resultado passa por um sorteio softmax, por isso a ordem nunca se repete igual.

Para não prender o ouvinte em um clima:

- uma **maré** de osciladores lentos muda o alvo ao longo das horas;
- uma **inquietação** cresce quando a sessão fica parada e empurra para a região menos visitada nas últimas 48 horas;
- o que tocou na sessão atual não conta como evidência, senão reforçaria a si mesmo.

## Medições

Ouvinte simulado com gosto escondido, dependente de hora e clima, ao longo de 21 dias:

| Política | Ouve até o fim, última semana |
| --- | --- |
| Aleatório | 54–57% |
| Metís | 72–75% |
| Oráculo que conhece o gosto | 86% |

É uma simulação: mostra que o aprendizado funciona, não prevê o resultado com pessoas reais.

## Limites conhecidos

- **Áudio do YouTube:** o navegador não acessa o áudio do iframe. A análise usa a prévia de 30 s do iTunes quando acha a música. Sem prévia, valem gênero e título.
- **BPM:** bom em música com pulso claro, menos confiável em baladas ao piano.
- **iPhone, tela bloqueada:** o YouTube para ao bloquear. Arquivos locais continuam.
- **iPhone, volume:** o iOS só aceita os botões físicos, então o controle fica oculto lá.
- **iPhone, troca automática:** o iOS pode exigir um toque para iniciar a música seguinte do YouTube.
- **Política do YouTube:** os termos da API exigem o player visível, com pelo menos 200 por 200 px. O Synapse o mantém atrás da interface, o que não cumpre essa regra e pode levar ao bloqueio da chave.
- **Fonte e ícones:** a licença da Apple para SF Pro e SF Symbols restringe o uso a produtos para plataformas Apple.
- **Backups:** não incluem os arquivos de áudio. Depois de importar, faixas locais precisam ser vinculadas de novo.

## Estrutura

```
js/metis/   modelo, sem DOM, testado no Node
js/core/    banco, reprodução, YouTube, contexto, tags, análise
js/ui/      desktop.js, mobile.js e peças comuns
css/        base, desktop, mobile, páginas
test/       testes do Metís e do DSP
tools/      servidor local e gerador de imagens
```

## Licença

MIT

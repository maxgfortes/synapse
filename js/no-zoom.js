// Bloqueia o zoom em todos os aparelhos. O Safari ignora user-scalable=no,
// entao o gesto de pinca precisa ser cancelado aqui.

(() => {
  const block = (event) => event.preventDefault();
  const options = { passive: false };

  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(name, block, options);
  }

  document.addEventListener('touchmove', (event) => {
    if (event.touches.length > 1) event.preventDefault();
  }, options);

  // Pinca no trackpad chega como wheel com ctrlKey.
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  }, options);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '_', '0'].includes(event.key)) event.preventDefault();
  });
})();

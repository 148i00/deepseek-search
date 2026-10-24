/* 在首帧绘制前应用主题，避免闪烁。 */
(function () {
  try {
    var saved = localStorage.getItem('dss.theme') || 'auto';
    var prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = saved === 'dark' || (saved === 'auto' && prefersDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();

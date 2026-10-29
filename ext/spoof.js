(() => {
  try { fetch('http://127.0.0.1:8080/probe?tag=ext&url=' + encodeURIComponent(location.href)).catch(() => {}); } catch (e) {}
  const V = 'Intel Inc.';
  const R = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const patch = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      if (p === 37445) return V;
      if (p === 37446) return R;
      return orig.apply(this, arguments);
    };
  };
  try { patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (e) {}
  try { patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true }); } catch (e) {}
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) { try { Object.defineProperty(AC.prototype, 'sampleRate', { get: () => 48000, configurable: true }); } catch (e) {} }
})();

/**
 * The loading screen and the can't-run screens. `index.html` paints `#boot` before any script runs: the NIGHT RUN
 * wordmark over three start lamps. The game fades it out once the title is up, or swaps it for a screen that says why
 * the race can't start.
 */

/** Which can't-run screen to show */
export type BootFailure = 'unsupported' | 'error';

/** True when this browser can draw the game with the renderer asked for: a WebGL 2 context, or WebGPU. */
export function canRun(webgpu: boolean): boolean {
  if (webgpu) return 'gpu' in navigator;

  const gl = document.createElement('canvas').getContext('webgl2');

  gl?.getExtension('WEBGL_lose_context')?.loseContext();

  return gl !== null;
}

/** Fades the loading screen out over the title, then removes it. */
export function bootDone(): void {
  const boot = document.getElementById('boot');

  if (!boot) return;
  boot.classList.add('out');
  boot.addEventListener('transitionend', () => boot.remove(), { once: true });
  // A tab in the background never ends the transition; the node goes anyway.
  setTimeout(() => boot.remove(), 800);
}

/** Swaps the loading screen for one that says why the race can't start, with a way out. */
export function bootFail(kind: BootFailure, detail = ''): void {
  const boot = document.getElementById('boot');

  if (!boot) return;
  const headline = document.createElement('h1');
  const body = document.createElement('p');
  const actions = document.createElement('div');
  const back = document.createElement('a');

  headline.textContent = kind === 'unsupported' ? "The lights won't come on here" : 'Something went wrong';
  body.className = 'body';
  body.textContent =
    kind === 'unsupported'
      ? 'NIGHT RUN needs WebGL 2 or WebGPU, and this browser has them turned off or blocked. Try a recent Chrome, Edge, Firefox or Safari, and check that hardware acceleration is on.'
      : 'NIGHT RUN hit an error while starting.';
  actions.className = 'actions';
  if (kind === 'error') {
    const reload = document.createElement('button');

    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => location.reload(), { once: true });
    actions.appendChild(reload);
  }
  back.href = 'https://github.com/pixijs/open-games';
  back.textContent = 'More PixiJS open games';
  actions.appendChild(back);

  const parts: HTMLElement[] = [headline, body];

  if (detail) {
    const error = document.createElement('p');

    error.className = 'error';
    error.textContent = detail;
    parts.push(error);
  }
  parts.push(actions);
  boot.classList.add('fail');
  boot.querySelector('.lamps')?.remove();
  boot.querySelector('.message')?.replaceChildren(...parts);
  (actions.firstElementChild as HTMLElement).focus();
}

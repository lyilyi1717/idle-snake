import './style.css';
import { Game } from './game';
import { UI } from './ui/ui';

async function boot() {
  const game = new Game();
  const ui = new UI(game);
  await game.start(ui);
  ui.refresh();
  setTimeout(() => document.getElementById('screenHint')?.classList.add('faded'), 15000);
  // Console handle for debugging only.
  (window as any).__snake = game;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();

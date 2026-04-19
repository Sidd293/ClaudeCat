// Tiny logger. Cat-themed because why not — this is the ClaudeCat POC.
import chalk from 'chalk';

const CATS = {
  orchestrator: '🐱',
  manager:      '📐',
  architect:    '📐',
  coder:        '⌨️ ',
  devops:       '🔧',
  launcher:     '🚀',
  docker:       '🐳',
  system:       '⚙️ ',
};

function stamp() {
  return chalk.gray(new Date().toISOString().slice(11, 19));
}

function tag(who) {
  const emoji = CATS[who] ?? '·';
  return chalk.bold(`${emoji} ${who.padEnd(12)}`);
}

export const log = {
  info:  (who, msg) => console.log(`${stamp()} ${tag(who)} ${msg}`),
  ok:    (who, msg) => console.log(`${stamp()} ${tag(who)} ${chalk.green('✓')} ${msg}`),
  warn:  (who, msg) => console.log(`${stamp()} ${tag(who)} ${chalk.yellow('!')} ${msg}`),
  err:   (who, msg) => console.log(`${stamp()} ${tag(who)} ${chalk.red('✗')} ${msg}`),
  step:  (who, msg) => console.log(`\n${stamp()} ${tag(who)} ${chalk.cyan('▸')} ${chalk.bold(msg)}`),
  dim:   (who, msg) => console.log(`${stamp()} ${tag(who)} ${chalk.gray(msg)}`),
  raw:   (msg)      => console.log(msg),
};

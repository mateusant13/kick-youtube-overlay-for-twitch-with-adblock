// The shipped JS files the gate syntax-checks and hashes into the receipt.
// One list, imported by the syntax check and by the receipt, so the two can
// never disagree about what the build consists of.
export const PRODUCT_JS = [
  'kick-overlay/background.js',
  'kick-overlay/content.js',
  'kick-overlay/twitch-adblock.js',
  'kick-overlay/player-bridge.js',
  'kick-overlay/adblock-bridge.js',
  'kick-overlay/popup.js',
];

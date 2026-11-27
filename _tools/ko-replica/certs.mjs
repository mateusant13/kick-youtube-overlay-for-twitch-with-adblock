#!/usr/bin/env node
// Generate the self-signed certificate the replica serves. Chrome reaches it
// through --host-resolver-rules, so the cert must name every host the replica
// impersonates. Lives in the declared store (G:), never in the checkout: I: is
// the SMR spindle with a write backlog (AGENTS.md 2026-11-24).
import { mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = process.env.KO_REPLICA_CERTS || 'G:/Temp/ko-replica/certs';
const HOSTS = [
  'www.twitch.tv',
  'gql.twitch.tv',
  'usher.ttvnw.net',
  'video-edge-a.playlist.ttvnw.net',
  '*.ttvnw.net',
  '*.live-video.net',
];
const OPENSSL = process.env.KO_OPENSSL || 'C:/Program Files/Git/usr/bin/openssl.exe';

export function ensureCerts({ quiet = false } = {}) {
  const cert = `${DIR}/cert.pem`;
  const key = `${DIR}/key.pem`;
  if (existsSync(cert) && existsSync(key)) {
    if (!quiet) console.log(`certs CACHE HIT ${DIR}`);
    return { cert, key };
  }
  mkdirSync(DIR, { recursive: true });
  const cn = HOSTS.map((h) => (h.startsWith('*.') ? h.slice(2) : h)).join(',');
  const addext = `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`;
  execFileSync(OPENSSL, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=www.twitch.tv',
    '-addext', addext,
  ], { timeout: 120000, killSignal: 'SIGKILL', stdio: quiet ? 'ignore' : 'inherit' });
  if (!quiet) console.log(`certs MISS -> ${DIR} (${cn})`);
  return { cert, key };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(ensureCerts()));
}

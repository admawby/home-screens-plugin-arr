// Build the release tarball the Home Screens installer expects: one top-level
// directory holding manifest.json and dist/ (it extracts with
// --strip-components=1). Writes plugin.tar.gz and prints its SHA-256.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const expected = process.env.EXPECT_VERSION?.replace(/^v/, '');
if (expected && expected !== manifest.version) {
  console.error(`Tag v${expected} does not match manifest version ${manifest.version}`);
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), 'hs-pkg-'));
const root = join(stage, manifest.id);
mkdirSync(join(root, 'dist'), { recursive: true });
cpSync('manifest.json', join(root, 'manifest.json'));
cpSync('dist/bundle.js', join(root, 'dist/bundle.js'));
cpSync('dist/bundle.js.map', join(root, 'dist/bundle.js.map'));
cpSync('LICENSE', join(root, 'LICENSE'));
execFileSync('tar', ['-czf', 'plugin.tar.gz', '-C', stage, manifest.id]);
rmSync(stage, { recursive: true, force: true });

const sha = createHash('sha256').update(readFileSync('plugin.tar.gz')).digest('hex');
console.log(`plugin.tar.gz  ${manifest.id}@${manifest.version}  sha256 ${sha}`);

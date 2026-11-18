import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(scrypt);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function hiddenPrompt(label) {
  if (!process.stdin.isTTY) return Promise.reject(new Error('대화형 터미널이 필요합니다.'));
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let value = '';
    const onData = (key) => {
      if (key === '\u0003') {
        cleanup();
        reject(new Error('취소되었습니다.'));
      } else if (key === '\r' || key === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (key === '\u007f' || key === '\b') {
        if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (key >= ' ') {
        value += key;
        process.stdout.write('•');
      }
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const supplied = process.env.SETUP_PASSWORD;
  const first = supplied || await hiddenPrompt('관리자 비밀번호(10자 이상): ');
  if (first.length < 10) throw new Error('관리자 비밀번호는 10자 이상이어야 합니다.');
  if (!supplied) {
    const second = await hiddenPrompt('관리자 비밀번호 확인: ');
    if (first !== second) throw new Error('비밀번호가 일치하지 않습니다.');
  }
  const salt = randomBytes(16);
  const N = 32768, r = 8, p = 1;
  const digest = await scryptAsync(first, salt, 64, { N, r, p, maxmem: 128 * 1024 * 1024 });
  const hash = `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  let existing = '';
  try { existing = await fs.readFile(envPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const kept = existing.split(/\r?\n/).filter((line) => line && !line.startsWith('ADMIN_PASSWORD_HASH=') && !line.startsWith('SESSION_SECRET='));
  kept.push(`ADMIN_PASSWORD_HASH=${hash}`);
  kept.push(`SESSION_SECRET=${randomBytes(48).toString('base64url')}`);
  await fs.writeFile(envPath, `${kept.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(envPath, 0o600);
  console.log('관리자 비밀번호 설정을 완료했습니다.');
}

main().catch((error) => { console.error(error.message); process.exit(1); });

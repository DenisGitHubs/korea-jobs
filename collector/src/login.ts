// collector/src/login.ts
//
// ONE-TIME interactive login for the reader account. Run by the OWNER:
//   npm run login
// The owner enters the phone number and the code Telegram sends (and the 2FA
// password if set). On success it prints the session string — copy it into
// collector/.env as TG_SESSION=... After that the reader connects headlessly and
// no code is needed again.
//
// NOTE: this is the only place a human types the code. Claude never enters it.
// The session string is equivalent to the account password — keep it secret.

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from './client.js';

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const client = createClient(''); // empty session — we are creating one

  await client.start({
    phoneNumber: async () => (await rl.question('Номер телефона (напр. +8210XXXXXXXX): ')).trim(),
    password: async () =>
      (await rl.question('Пароль двухэтапной аутентификации (Enter, если нет): ')).trim(),
    phoneCode: async () => (await rl.question('Код из Telegram/СМС: ')).trim(),
    onError: (err) => console.error('Ошибка входа:', err),
  });

  const sessionString = client.session.save() as unknown as string;

  // Write the session straight into collector/.env so the owner never has to
  // copy/paste a ~300-char secret by hand (and it is never shown on screen).
  // Falls back to printing it if the file write fails — so a login is never wasted.
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let saved = false;
  try {
    let text = readFileSync(envPath, 'utf8');
    if (/^TG_SESSION=.*$/m.test(text)) {
      text = text.replace(/^TG_SESSION=.*$/m, () => 'TG_SESSION=' + sessionString);
    } else {
      text = text.replace(/\s*$/, '') + '\nTG_SESSION=' + sessionString + '\n';
    }
    writeFileSync(envPath, text, 'utf8');
    saved = true;
  } catch (err) {
    console.error('Не удалось записать collector/.env автоматически:', err);
  }

  console.log('\n==================================================================');
  if (saved) {
    console.log(' ГОТОВО. Сессия сохранена в collector/.env (TG_SESSION).');
    console.log(' Ничего копировать не нужно — напиши Дэну: готово.');
  } else {
    console.log(' Вход удался, но авто-сохранение не сработало. Скопируй строку');
    console.log(' ниже в collector/.env после  TG_SESSION=  и сохрани (Ctrl+S):');
    console.log('------------------------------------------------------------------');
    console.log(sessionString);
  }
  console.log('==================================================================\n');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('login failed:', err);
  process.exit(1);
});

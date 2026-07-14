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

  console.log('\n==================================================================');
  console.log(' ГОТОВО. Скопируй строку ниже в collector/.env как TG_SESSION=');
  console.log(' Никому её не показывай — это как пароль от аккаунта.');
  console.log('==================================================================\n');
  console.log(sessionString);
  console.log('\n==================================================================');

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('login failed:', err);
  process.exit(1);
});

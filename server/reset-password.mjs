import { randomBytes, scrypt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const usersFile = process.env.TODO_USERS_FILE || path.join(here, 'data', 'users.json');

const email = process.argv[2]?.trim().toLowerCase();
const newPassword = process.argv[3];

if (!email || !newPassword) {
  console.log('Usage: node server/reset-password.mjs <email> <new-password>');
  process.exit(1);
}

if (newPassword.length < 8) {
  console.error('Password must be at least 8 characters long.');
  process.exit(1);
}

try {
  const raw = await fs.readFile(usersFile, 'utf8');
  const data = JSON.parse(raw);
  const user = data.users.find((u) => u.email.toLowerCase() === email);

  if (!user) {
    console.error(`User with email "${email}" not found.`);
    console.log('Existing emails:');
    data.users.forEach((u) => console.log(` - ${u.email}`));
    process.exit(1);
  }

  const salt = randomBytes(16).toString('hex');
  const key = await new Promise((resolve, reject) => {
    scrypt(newPassword, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });

  user.salt = salt;
  user.passwordHash = key.toString('hex');

  await fs.writeFile(usersFile, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ Password successfully reset for ${email}! You can now sign in with your new password.`);
} catch (error) {
  console.error('Failed to reset password:', error.message);
  process.exit(1);
}


import { cloneUserSettings, db } from '../src/db.mjs';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node scripts/clone-user-settings.mjs <source> <target>');
  process.exitCode = 2;
} else {
  try {
    const result = cloneUserSettings(source, target, target);
    console.log(
      `Copied ${result.settingsCount} settings rows from ${source} to ${result.user.email}.`,
    );
  } finally {
    db.close();
  }
}

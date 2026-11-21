import { prisma } from '../src/prisma';
import { normalizePhoneNumber } from '../src/utils/phone';
import { Role } from '@seas/shared';

async function main() {
  const rawPhone = process.argv[2];

  if (!rawPhone) {
    console.error('Error: Please provide a phone number to grant admin access.');
    console.log('Usage: npm run grant-admin <phoneNumber>');
    console.log('Example: npm run grant-admin 0712345678');
    process.exit(1);
  }

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhoneNumber(rawPhone);
  } catch (err: any) {
    console.error(`Error: Invalid phone number format: ${err.message}`);
    process.exit(1);
  }

  // Look up user
  let user = await prisma.user.findUnique({
    where: { phoneNumber: normalizedPhone },
  });

  if (!user) {
    console.log(`User ${normalizedPhone} not found in database. Provisioning new ADMIN account...`);
    user = await prisma.user.create({
      data: {
        phoneNumber: normalizedPhone,
        name: `Admin ${normalizedPhone.slice(-4)}`,
        role: Role.ADMIN,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { role: Role.ADMIN },
    });
  }

  // Record to AuditLog (Non-negotiable constraint #6)
  await prisma.auditLog.create({
    data: {
      actorId: 'CLI_PROVISIONING',
      action: 'ADMIN_ROLE_GRANTED',
      targetId: user.id,
    },
  });

  console.log('====================================================');
  console.log(`SUCCESS: User ${user.phoneNumber} (${user.name}) is now an ADMIN.`);
  console.log('====================================================');
  console.log('Next steps:');
  console.log('1. Log in (or log out and log back in) at http://localhost:5173/login');
  console.log('2. The "Admin" tab will appear on your top navigation bar.');
  console.log('3. You can access the Operations Dashboard directly at http://localhost:5173/admin');
  console.log('====================================================');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

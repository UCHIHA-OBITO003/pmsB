import { prisma } from './src/utils/prisma';
async function run() {
  await prisma.ticket.updateMany({ data: { rowHash: null } });
  console.log('Reset row hashes');
}
run();

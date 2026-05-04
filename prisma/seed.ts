import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create permissions
  const resources = ['users', 'projects', 'tickets', 'sprints', 'roles', 'analytics', 'audit', 'excel', 'ai'];
  const actions = ['create', 'read', 'update', 'delete'];

  const permissionData = resources.flatMap((resource) =>
    actions.map((action) => ({ resource, action }))
  );

  await prisma.permission.createMany({ data: permissionData, skipDuplicates: true });
  console.log(`✅ Created ${permissionData.length} permissions`);

  // Create roles
  const allPerms = await prisma.permission.findMany();

  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    create: { name: 'admin', description: 'Full system access', isSystem: true },
    update: {},
  });

  const pmRole = await prisma.role.upsert({
    where: { name: 'project_manager' },
    create: { name: 'project_manager', description: 'Project management access', isSystem: true },
    update: {},
  });

  const devRole = await prisma.role.upsert({
    where: { name: 'developer' },
    create: { name: 'developer', description: 'Developer access', isSystem: true },
    update: {},
  });

  const qaRole = await prisma.role.upsert({
    where: { name: 'qa' },
    create: { name: 'qa', description: 'QA access', isSystem: true },
    update: {},
  });

  const stakeholderRole = await prisma.role.upsert({
    where: { name: 'stakeholder' },
    create: { name: 'stakeholder', description: 'Read-only stakeholder access', isSystem: true },
    update: {},
  });

  // Admin gets all permissions
  const adminPermData = allPerms.map((p) => ({ roleId: adminRole.id, permissionId: p.id }));
  await prisma.rolePermission.createMany({ data: adminPermData, skipDuplicates: true });

  // PM gets most permissions except role management
  const pmPerms = allPerms.filter((p) => p.resource !== 'roles' || p.action === 'read');
  await prisma.rolePermission.createMany({
    data: pmPerms.map((p) => ({ roleId: pmRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  // Developer gets read/create/update on tickets, read on projects/sprints/analytics, team roster (Team page uses GET /users)
  const devPerms = allPerms.filter((p) =>
    (p.resource === 'tickets' && ['create', 'read', 'update'].includes(p.action)) ||
    (p.resource === 'sprints' && p.action === 'read') ||
    (p.resource === 'projects' && p.action === 'read') ||
    (p.resource === 'analytics' && p.action === 'read') ||
    (p.resource === 'users' && p.action === 'read')
  );
  await prisma.rolePermission.createMany({
    data: devPerms.map((p) => ({ roleId: devRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  // QA — same ticket workflow as developers
  const qaPerms = allPerms.filter((p) =>
    (p.resource === 'tickets' && ['create', 'read', 'update'].includes(p.action)) ||
    (p.resource === 'sprints' && p.action === 'read') ||
    (p.resource === 'projects' && p.action === 'read') ||
    (p.resource === 'analytics' && p.action === 'read') ||
    (p.resource === 'users' && p.action === 'read')
  );
  await prisma.rolePermission.createMany({
    data: qaPerms.map((p) => ({ roleId: qaRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  // Stakeholder — read-only access to tickets & projects
  const stakeholderPerms = allPerms.filter((p) =>
    (p.resource === 'tickets' && p.action === 'read') ||
    (p.resource === 'projects' && p.action === 'read') ||
    (p.resource === 'users' && p.action === 'read')
  );
  await prisma.rolePermission.createMany({
    data: stakeholderPerms.map((p) => ({ roleId: stakeholderRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  console.log('✅ Roles and permissions created');

  // Create admin user
  const adminPwd = await bcrypt.hash('Admin@123456', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@pms.local' },
    create: {
      email: 'admin@pms.local',
      password: adminPwd,
      firstName: 'System',
      lastName: 'Admin',
      department: 'Engineering',
      designation: 'Platform Admin',
      emailVerified: true,
      roles: { create: [{ roleId: adminRole.id }] },
    },
    update: {},
  });

  console.log(`✅ Admin user created: admin@pms.local / Admin@123456`);

  // Create sample project
  const project = await prisma.project.upsert({
    where: { key: 'EEP' },
    create: {
      name: 'Engineering Execution Platform',
      key: 'EEP',
      description: 'Internal Delivery OS',
      status: 'ACTIVE',
      ownerId: admin.id,
      members: { create: [{ userId: admin.id, role: 'pm' }] },
      workflowStates: {
        create: [
          { name: 'To Do', slug: 'todo', color: '#94a3b8', order: 0, isDefault: true },
          { name: 'In Progress', slug: 'in_progress', color: '#3b82f6', order: 1 },
          { name: 'In Review', slug: 'in_review', color: '#f59e0b', order: 2 },
          { name: 'Blocked', slug: 'blocked', color: '#ef4444', order: 3 },
          { name: 'Done', slug: 'done', color: '#22c55e', order: 4, isFinal: true },
        ],
      },
    },
    update: {},
  });

  console.log(`✅ Sample project created: EEP`);
  console.log('\n🎉 Seed complete!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

import { prisma } from './src/utils/prisma';
import { excelImportService } from './src/services/excel-import.service';

async function setupAndSync() {
  try {
    // 1. Get the EEP project
    const project = await prisma.project.findFirst({
      where: { key: 'EEP' }
    });

    if (!project) {
      console.error('EEP project not found!');
      return;
    }

    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1luaRJMHaGggJKl_jaWGhlIzXlqJcb1CbnuBXcyTiMfk/edit?gid=0#gid=0';
    
    // 2. Upsert config
    console.log('Creating SheetSyncConfig...');
    const config = await excelImportService.upsertSyncConfig({
      projectId: project.id,
      sheetUrl,
      intervalMins: 30,
      columnMapping: {
        title: 'Task',
        status: 'Status',
        module: 'Module',
        sourceUrl: 'Ticket',
        description: 'Notes',
        screen: 'Screen'
      },
      createdBy: 'system'
    });
    
    console.log('Config created:', config.id);

    // 3. Trigger a manual sync right now to import all the tickets
    console.log('Starting sync...');
    const stats = await excelImportService.syncGoogleSheet(
      config.sheetId,
      project.id,
      'system',
      config.columnMapping as any,
      config.id
    );

    console.log('Sync complete!', stats);

  } catch (err) {
    console.error('Failed:', err);
  }
}

setupAndSync();

import { excelImportService } from './src/services/excel-import.service';
import { logger } from './src/utils/logger';

async function testSync() {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1luaRJMHaGggJKl_jaWGhlIzXlqJcb1CbnuBXcyTiMfk/edit?gid=0#gid=0';
    const sheetId = '1luaRJMHaGggJKl_jaWGhlIzXlqJcb1CbnuBXcyTiMfk';
    
    console.log('Previewing sheet...');
    const preview = await excelImportService.previewSheet(sheetId, 'A:Z', 5);
    console.log(JSON.stringify(preview, null, 2));

  } catch (err) {
    console.error('Failed:', err);
  }
}

testSync();

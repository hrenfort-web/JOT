import { run } from '../../db/database';
import { saveProjects, BqeProject } from '../bqe/project';
import { saveActivities, BqeActivity } from '../bqe/activity';
import { saveEmployees, BqeEmployee } from '../bqe/employee';
import { getMonday, toIsoDay } from '../../utils/dateHelpers';

const DEMO_ID_PREFIX = 'demo-';

const PARENT_PROJECTS: Array<{
  id: string;
  name: string;
  code: string;
  client: string;
}> = [
  { id: 'demo-smith', name: 'Smith Residence', code: '2024-031', client: 'John & Jane Smith' },
  { id: 'demo-oakwood', name: 'Oakwood Mixed-Use', code: '2024-018', client: 'Oakwood Partners LLC' },
  { id: 'demo-library', name: 'Downtown Library', code: '2023-045', client: 'City of Bayview' },
];

const PHASE_CODES = ['SD', 'DD', 'CD', 'CA'] as const;

function buildDemoProjects(): BqeProject[] {
  const out: BqeProject[] = [];
  for (const parent of PARENT_PROJECTS) {
    out.push({
      id: parent.id,
      name: parent.name,
      code: parent.code,
      parentId: null,
      client: { name: parent.client },
      isActive: true,
    });
    for (const phase of PHASE_CODES) {
      out.push({
        id: `${parent.id}-${phase.toLowerCase()}`,
        name: `${parent.name} - ${phase}`,
        code: `${parent.code}-${phase}`,
        parentId: parent.id,
        client: { name: parent.client },
        isActive: true,
      });
    }
  }
  return out;
}

const DEMO_ACTIVITIES: BqeActivity[] = [
  { id: 'demo-act-design', name: 'Design', code: 'DES', billable: true, isActive: true },
  { id: 'demo-act-draft', name: 'Drafting', code: 'DRAFT', billable: true, isActive: true },
  { id: 'demo-act-meet', name: 'Client Meeting', code: 'MTG', billable: true, isActive: true },
];

export const DEMO_EMPLOYEE: BqeEmployee = {
  id: 'demo-user',
  displayName: 'Demo User',
  firstName: 'Demo',
  lastName: 'User',
};

export const DEMO_ENDPOINT = 'https://demo.local/api';
export const DEMO_ACCESS_TOKEN = 'demo-access-token';

interface SampleEntry {
  dayOffset: number;
  phaseId: string;
  hours: number;
  memo: string;
}

const SAMPLE_WEEK_ENTRIES: SampleEntry[] = [
  { dayOffset: 0, phaseId: 'demo-smith-dd', hours: 6, memo: 'Drawing development, structural coord' },
  { dayOffset: 0, phaseId: 'demo-oakwood-cd', hours: 2, memo: 'Document production' },
  { dayOffset: 1, phaseId: 'demo-smith-dd', hours: 4.5, memo: 'Client revisions' },
  { dayOffset: 1, phaseId: 'demo-library-sd', hours: 3, memo: 'Site analysis' },
  { dayOffset: 2, phaseId: 'demo-smith-dd', hours: 7.5, memo: 'Consultant coordination' },
];

export async function seedDemoData(): Promise<void> {
  await saveProjects(buildDemoProjects());
  await saveActivities(DEMO_ACTIVITIES);
  await saveEmployees([DEMO_EMPLOYEE]);
  await seedSampleEntries();
}

async function seedSampleEntries(): Promise<void> {
  const monday = getMonday(new Date());
  const now = new Date().toISOString();

  await run(`DELETE FROM LocalTimeEntry WHERE bqeId LIKE 'demo-entry-%'`);

  for (let i = 0; i < SAMPLE_WEEK_ENTRIES.length; i++) {
    const entry = SAMPLE_WEEK_ENTRIES[i];
    const date = new Date(monday);
    date.setDate(monday.getDate() + entry.dayOffset);
    const iso = toIsoDay(date);
    await run(
      `INSERT INTO LocalTimeEntry
       (bqeId, projectId, activityId, resourceId, date, hours, memo, isBillable, syncStatus, source, createdAt, version, billStatus, submissionStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'synced', 'manual', ?, '1', 'Open', 'draft')`,
      [
        `demo-entry-${i + 1}`,
        entry.phaseId,
        DEMO_ACTIVITIES[0].id,
        DEMO_EMPLOYEE.id,
        iso,
        entry.hours,
        entry.memo,
        now,
      ],
    );
  }
}

export async function clearDemoData(): Promise<void> {
  await run(`DELETE FROM LocalTimeEntry WHERE projectId LIKE '${DEMO_ID_PREFIX}%' OR bqeId LIKE 'demo-entry-%'`);
  await run(`DELETE FROM LocalProject WHERE id LIKE '${DEMO_ID_PREFIX}%'`);
  await run(`DELETE FROM LocalActivity WHERE id LIKE '${DEMO_ID_PREFIX}%'`);
  await run(`DELETE FROM LocalEmployee WHERE id LIKE '${DEMO_ID_PREFIX}%'`);
}

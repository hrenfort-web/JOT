import type { LocalProject } from '../../db/schema';

export interface PhaseLookup {
  code: string | null;
  name: string;
  phaseProjectId: string;
}

export interface ProjectLookupEntry {
  projectName: string;
  projectId: string;
  shortcuts: string[];
  phases: PhaseLookup[];
}

export function buildProjectLookup(projects: LocalProject[]): ProjectLookupEntry[] {
  const tops = projects.filter((p) => !p.isPhase && p.isActive);
  const phasesByParent = new Map<string, LocalProject[]>();
  for (const p of projects) {
    if (p.isPhase && p.isActive && p.parentId) {
      const list = phasesByParent.get(p.parentId) ?? [];
      list.push(p);
      phasesByParent.set(p.parentId, list);
    }
  }

  return tops
    .map<ProjectLookupEntry>((top) => {
      const children = phasesByParent.get(top.id) ?? [];
      const phases: PhaseLookup[] = children.map((ph) => ({
        code: ph.phaseCode,
        name: ph.name,
        phaseProjectId: ph.id,
      }));
      if (phases.length === 0) {
        phases.push({ code: null, name: top.name, phaseProjectId: top.id });
      }
      return {
        projectName: top.name,
        projectId: top.id,
        shortcuts: deriveShortcuts(top.name, top.code),
        phases,
      };
    })
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

function deriveShortcuts(name: string, code: string | null): string[] {
  const out = new Set<string>();
  const trimmed = name.trim();
  if (!trimmed) return [];

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words[0]) out.add(words[0]);
  if (words.length >= 2) out.add(words.slice(0, 2).join(' '));

  const initials = words
    .map((w) => w[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  if (initials.length >= 2 && initials.length <= 5) out.add(initials);

  const firstWord = words[0];
  if (firstWord && firstWord.length >= 4) {
    out.add(firstWord.slice(0, 3));
  }

  if (code) out.add(code);

  return Array.from(out);
}

export function lookupTableToPromptString(entries: ProjectLookupEntry[]): string {
  const lines: string[] = [];
  lines.push('| Shorthand | Full Name | Project ID | Phase | Phase ID |');
  lines.push('|---|---|---|---|---|');
  for (const entry of entries) {
    const shortcuts = entry.shortcuts.join(', ') || entry.projectName;
    for (const phase of entry.phases) {
      const phaseLabel = phase.code ?? phase.name;
      lines.push(
        `| ${shortcuts} | ${entry.projectName} | ${entry.projectId} | ${phaseLabel} | ${phase.phaseProjectId} |`,
      );
    }
  }
  return lines.join('\n');
}

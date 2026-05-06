import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { MemoChip } from './MemoChip';
import { ProjectPickerModal } from './ProjectPickerModal';
import { useProjectStore } from '../store/useProjectStore';
import {
  adjustHours,
  formatEntryHours,
  setHoursValue,
} from '../utils/hourMath';
import {
  MemoSuggestions,
  getMemoSuggestions,
} from '../services/memos/suggestions';
import { phaseMeta } from '../utils/phaseMeta';

const MEMO_MIN = 3;
const MEMO_MAX = 100;
const BASE_HOURS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const MODIFIERS = [
  { label: '− .25', delta: -0.25 },
  { label: '+ .25', delta: 0.25 },
  { label: '+ .50', delta: 0.5 },
  { label: 'Clear', reset: true as const },
];

export interface EditorValue {
  projectId: string | null;
  phaseProjectId: string | null;
  hours: number;
  memo: string;
}

interface ReviewEntryEditorProps {
  initial: EditorValue;
  onSave: (value: EditorValue) => void;
  onRemove?: () => void;
  onCancel: () => void;
  showRemove?: boolean;
}

export function ReviewEntryEditor({
  initial,
  onSave,
  onRemove,
  onCancel,
  showRemove,
}: ReviewEntryEditorProps) {
  const flatProjects = useProjectStore((s) => s.flatProjects);

  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [phaseProjectId, setPhaseProjectId] = useState<string | null>(initial.phaseProjectId);
  const [hours, setHours] = useState(initial.hours);
  const [memo, setMemo] = useState(initial.memo);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<MemoSuggestions>({
    label: '',
    chips: [],
    hasHistory: false,
  });
  const [tappedChips, setTappedChips] = useState<Set<string>>(new Set());

  const project = useMemo(
    () => (projectId ? flatProjects.find((p) => p.id === projectId) ?? null : null),
    [projectId, flatProjects],
  );
  const phases = useMemo(
    () =>
      projectId
        ? flatProjects.filter((p) => p.isPhase && p.parentId === projectId)
        : [],
    [projectId, flatProjects],
  );
  const selectedPhase = useMemo(
    () => (phaseProjectId ? flatProjects.find((p) => p.id === phaseProjectId) ?? null : null),
    [phaseProjectId, flatProjects],
  );

  useEffect(() => {
    if (!phaseProjectId) return;
    const stillBelongs = phases.some((p) => p.id === phaseProjectId);
    if (!stillBelongs) {
      setPhaseProjectId(phases[0]?.id ?? projectId ?? null);
    }
  }, [phases, phaseProjectId, projectId]);

  useEffect(() => {
    const target = phaseProjectId ?? projectId;
    if (!target) {
      setSuggestions({ label: '', chips: [], hasHistory: false });
      return;
    }
    let cancelled = false;
    (async () => {
      const phaseCode = selectedPhase?.phaseCode ?? null;
      const result = await getMemoSuggestions(target, phaseCode);
      if (!cancelled) setSuggestions(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [phaseProjectId, projectId, selectedPhase]);

  const onTapChip = (chip: string) => {
    const trimmed = memo.trim();
    const next = trimmed.length === 0 ? chip : `${trimmed}, ${chip}`;
    setMemo(next.slice(0, MEMO_MAX));
    setTappedChips((prev) => new Set(prev).add(chip));
  };

  const memoTrim = memo.trim();
  const memoValid = memoTrim.length >= MEMO_MIN;
  const targetPhaseId = phaseProjectId ?? (phases.length === 0 ? projectId : null);
  const canSave = !!projectId && !!targetPhaseId && hours > 0 && memoValid;

  const onPickProject = (newProjectId: string) => {
    setProjectId(newProjectId);
    const newPhases = flatProjects.filter((p) => p.isPhase && p.parentId === newProjectId);
    setPhaseProjectId(newPhases[0]?.id ?? newProjectId);
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      projectId,
      phaseProjectId: targetPhaseId,
      hours,
      memo: memoTrim,
    });
  };

  return (
    <View style={styles.editor}>
      <Pressable
        onPress={() => setPickerOpen(true)}
        style={({ pressed }) => [styles.projectRow, pressed && styles.pressed]}
      >
        <View
          style={[
            styles.dot,
            { backgroundColor: project?.color ?? colors.border },
          ]}
        />
        <Text style={styles.projectName} numberOfLines={1}>
          {project?.name ?? 'Choose project'}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.muted} />
      </Pressable>

      {phases.length > 0 ? (
        <View style={styles.phaseRow}>
          {phases.map((p) => {
            const meta = phaseMeta(p.phaseCode, p.name);
            const selected = p.id === phaseProjectId;
            return (
              <Pressable
                key={p.id}
                onPress={() => setPhaseProjectId(p.id)}
                style={({ pressed }) => [
                  styles.phaseBtn,
                  selected && styles.phaseBtnSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.phaseCode, selected && styles.phaseCodeSelected]}>
                  {meta.code}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.hoursDisplay}>
        <Text style={styles.hoursValue}>{formatEntryHours(hours)}</Text>
        <Text style={styles.hoursUnit}>hours</Text>
      </View>

      <View style={styles.baseGrid}>
        {BASE_HOURS.map((n) => {
          const selected = hours === n;
          return (
            <Pressable
              key={n}
              onPress={() => setHours(setHoursValue(n))}
              style={({ pressed }) => [
                styles.baseBtn,
                selected && styles.baseBtnSelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.baseBtnText, selected && styles.baseBtnTextSelected]}>
                {n}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.modRow}>
        {MODIFIERS.map((m) => (
          <Pressable
            key={m.label}
            onPress={() => {
              if (m.reset) setHours(0);
              else setHours((current) => adjustHours(current, m.delta!));
            }}
            style={({ pressed }) => [
              styles.modBtn,
              m.reset && styles.modBtnClear,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.modText, m.reset && styles.modTextClear]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        value={memo}
        onChangeText={(t) => setMemo(t.slice(0, MEMO_MAX))}
        placeholder="What did you work on?"
        placeholderTextColor={colors.muted}
        multiline
        maxLength={MEMO_MAX}
        style={[
          styles.memoInput,
          { borderColor: memoValid ? colors.accent : colors.border },
        ]}
      />

      {suggestions.chips.length > 0 ? (
        <View style={styles.chipsRow}>
          {suggestions.chips.slice(0, 4).map((chip) => (
            <MemoChip
              key={chip}
              label={chip}
              selected={tappedChips.has(chip)}
              onPress={() => onTapChip(chip)}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.actionRow}>
        {showRemove && onRemove ? (
          <Pressable
            onPress={onRemove}
            style={({ pressed }) => [styles.removeBtn, pressed && styles.pressed]}
          >
            <Ionicons name="trash-outline" size={16} color={colors.danger} />
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.pressed]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        )}

        <Pressable
          onPress={handleSave}
          disabled={!canSave}
          style={({ pressed }) => [
            styles.saveBtn,
            !canSave && styles.saveBtnDisabled,
            pressed && canSave && styles.pressed,
          ]}
        >
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
      </View>

      <ProjectPickerModal
        visible={pickerOpen}
        currentProjectId={projectId}
        onSelect={onPickProject}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  editor: {
    backgroundColor: colors.background,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.accent,
    padding: 12,
    gap: 12,
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.subtle,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  projectName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  phaseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  phaseBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
  },
  phaseBtnSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  phaseCode: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  phaseCodeSelected: {
    color: '#FFFFFF',
  },
  hoursDisplay: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  hoursValue: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -1,
  },
  hoursUnit: {
    fontSize: 11,
    color: colors.muted,
  },
  baseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  baseBtn: {
    width: '23.5%',
    aspectRatio: 1.6,
    borderRadius: 10,
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  baseBtnSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  baseBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  baseBtnTextSelected: {
    color: '#FFFFFF',
  },
  modRow: {
    flexDirection: 'row',
    gap: 6,
  },
  modBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.subtle,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modBtnClear: {
    backgroundColor: colors.background,
  },
  modText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
  },
  modTextClear: {
    color: colors.danger,
  },
  memoInput: {
    minHeight: 56,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    textAlignVertical: 'top',
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
  removeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  removeText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger,
  },
  saveBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  saveBtnDisabled: {
    backgroundColor: colors.border,
  },
  saveText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.75,
  },
});

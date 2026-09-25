import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { colors } from '../theme';
import { formatHours } from '../utils/dateHelpers';
import { SubmissionBadge } from './SubmissionBadge';
import { PhasePill } from './PhasePill';
import type { SyncStatus } from '../db/schema';

interface EntryRowProps {
  projectName: string;
  phaseLabel: string | null;
  hours: number;
  memo: string | null;
  color: string;
  locked?: boolean;
  /** The row's sync state, rendered honestly: see stateHint below. */
  syncStatus: SyncStatus;
  /** Last sync error, shown on a pending row that is awaiting a retry. */
  lastError?: string | null;
  submissionStatus?: string | null;
  onPress?: () => void;
  onDelete?: () => void;
}

const MEMO_PREVIEW_MAX = 48;
const LAST_ERROR_PREVIEW_MAX = 60;

interface EntryA11yInput {
  projectName: string;
  phaseLabel: string | null;
  hours: number;
  memo: string | null;
  locked?: boolean;
  syncStatus: SyncStatus;
  lastError?: string | null;
}

// The one place the sync state becomes user-facing text. Returned as the
// visible hint under the memo; the a11y chunk below mirrors it.
//   in_flight            → "Saving…"           (a POST is on the wire)
//   pending, no error    → "Waiting to sync"   (queued, nothing tried yet)
//   pending, lastError   → "Will retry — <why>" (a previous attempt didn't
//                          resolve; the queue will reconcile and retry)
//   failed               → "Failed to sync — tap to retry" (server said no,
//                          or retries ran out; lastError has the reason)
//   synced               → no hint
function stateHint(syncStatus: SyncStatus, lastError: string | null | undefined): string | null {
  switch (syncStatus) {
    case 'failed':
      return 'Failed to sync — tap to retry';
    case 'in_flight':
      return 'Saving…';
    case 'pending':
      return lastError && lastError.trim().length > 0
        ? `Will retry — ${lastError.trim().slice(0, LAST_ERROR_PREVIEW_MAX)}`
        : 'Waiting to sync';
    case 'synced':
    default:
      return null;
  }
}

// Compose a single screen-reader sentence summarising an entry. Mirrors the
// visible chrome (project, phase, hours, memo) plus any sync state, so VO
// users hear the same information sighted users see at a glance.
function buildEntryA11yLabel(e: EntryA11yInput): string {
  const phaseChunk = e.phaseLabel ? `, ${e.phaseLabel}` : '';
  const memoChunk = e.memo && e.memo.trim().length > 0 ? `, ${e.memo}` : '';
  const stateChunk = e.locked
    ? ', locked'
    : e.syncStatus === 'failed'
      ? ', failed to sync'
      : e.syncStatus === 'in_flight'
        ? ', saving'
        : e.syncStatus === 'pending'
          ? e.lastError
            ? ', will retry'
            : ', waiting to sync'
          : '';
  return `${e.projectName}${phaseChunk}, ${formatHours(e.hours)} hours${memoChunk}${stateChunk}`;
}

export function EntryRow({
  projectName,
  phaseLabel,
  hours,
  memo,
  color,
  locked,
  syncStatus,
  lastError,
  submissionStatus,
  onPress,
  onDelete,
}: EntryRowProps) {
  const swipeRef = useRef<Swipeable>(null);
  const failed = syncStatus === 'failed';
  const inProgress = syncStatus === 'pending' || syncStatus === 'in_flight';
  const hint = stateHint(syncStatus, lastError);

  const memoPreview = memo
    ? memo.length > MEMO_PREVIEW_MAX
      ? `${memo.slice(0, MEMO_PREVIEW_MAX).trimEnd()}…`
      : memo
    : null;

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>,
  ) => {
    if (locked || !onDelete) return null;
    const translate = dragX.interpolate({
      inputRange: [-96, 0],
      outputRange: [0, 96],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View style={[styles.deleteWrap, { transform: [{ translateX: translate }] }]}>
        <Pressable
          onPress={() => {
            swipeRef.current?.close();
            onDelete?.();
          }}
          style={({ pressed }) => [styles.deleteBtn, pressed && styles.deleteBtnPressed]}
        >
          <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
          <Text style={styles.deleteText}>Delete</Text>
        </Pressable>
      </Animated.View>
    );
  };

  const handlePress = () => {
    if (locked) return;
    onPress?.();
  };

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={locked ? undefined : renderRightActions}
      overshootRight={false}
      friction={2}
      rightThreshold={40}
      // Explicit horizontal-drag activation threshold. Required after reanimated 4
      // install (commit a60a6cc) altered the gesture-handler responder arbitration
      // on the New Arch. Without this, Pressable's onPress wins the touch-up race
      // against legacy Swipeable's default "activate on any motion".
      activeOffsetX={[-10, 10]}
      enabled={!locked && !!onDelete}
    >
      <Pressable
        onPress={handlePress}
        disabled={locked}
        accessibilityRole="button"
        accessibilityLabel={buildEntryA11yLabel({
          projectName,
          phaseLabel,
          hours,
          memo,
          locked,
          syncStatus,
          lastError,
        })}
        accessibilityHint={
          locked
            ? 'Locked — cannot be edited'
            : failed
              ? 'Tap to retry sync'
              : 'Tap to edit, swipe left to delete'
        }
        style={({ pressed }) => [
          styles.row,
          pressed && !locked && styles.rowPressed,
          locked && styles.rowLocked,
          failed && styles.rowFailed,
        ]}
      >
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1}>
              {projectName}
            </Text>
            {phaseLabel ? <PhasePill code={phaseLabel} tintColor={color} size="sm" /> : null}
            <SubmissionBadge status={submissionStatus ?? null} />
          </View>
          {memoPreview ? (
            <Text style={styles.memo} numberOfLines={1}>
              {memoPreview}
            </Text>
          ) : (
            <Text style={[styles.memo, styles.memoEmpty]}>No memo</Text>
          )}
          {hint ? (
            <Text style={failed ? styles.failedHint : styles.pendingHint}>{hint}</Text>
          ) : null}
        </View>
        <View style={styles.right}>
          <Text style={styles.hours}>{formatHours(hours)}h</Text>
          {locked ? (
            <Ionicons name="lock-closed" size={16} color={colors.textTertiary} />
          ) : failed ? (
            <Ionicons name="alert-circle" size={18} color={colors.danger} />
          ) : inProgress ? (
            <Ionicons name="cloud-upload-outline" size={16} color="#B45309" />
          ) : (
            <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
          )}
        </View>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  // Theme B entry row: same hairline-cream-card treatment as ProjectCard.
  // The data inside (project name, memo, hours) carries the visual weight;
  // chrome stays out of the way so a day's entries read as a calm list.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowPressed: {
    backgroundColor: colors.subtle,
  },
  rowLocked: {
    backgroundColor: colors.subtle,
    opacity: 0.85,
  },
  rowFailed: {
    borderColor: colors.danger,
    // Hairline doesn't read on the failed state — bump to 1px so the
    // danger border is felt.
    borderWidth: 1,
  },
  failedHint: {
    fontSize: 11,
    color: colors.danger,
    fontWeight: '500',
    marginTop: 2,
  },
  pendingHint: {
    fontSize: 11,
    color: '#B45309',
    fontWeight: '500',
    marginTop: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Project name: 14px weight 400 primary text. Earlier weight 600 read
  // too heavily on a list of entries — the data is already strong, the
  // type doesn't need to shout.
  name: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.text,
    flexShrink: 1,
  },
  memo: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.text,
  },
  memoEmpty: {
    fontStyle: 'italic',
    color: colors.textTertiary,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Hours value: same size as the name, half a weight heavier — reads
  // as the focal number without dominating.
  hours: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    textAlign: 'right',
  },
  deleteWrap: {
    width: 96,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingLeft: 6,
  },
  deleteBtn: {
    backgroundColor: colors.danger,
    width: 90,
    height: '100%',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  deleteBtnPressed: {
    opacity: 0.85,
  },
  deleteText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: '500',
  },
});

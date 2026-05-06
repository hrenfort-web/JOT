import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { colors } from '../theme';
import { formatHours } from '../utils/dateHelpers';
import { SubmissionBadge } from './SubmissionBadge';

interface EntryRowProps {
  projectName: string;
  phaseLabel: string | null;
  hours: number;
  memo: string | null;
  color: string;
  locked?: boolean;
  pending?: boolean;
  failed?: boolean;
  submissionStatus?: string | null;
  onPress?: () => void;
  onDelete?: () => void;
}

const MEMO_PREVIEW_MAX = 48;

export function EntryRow({
  projectName,
  phaseLabel,
  hours,
  memo,
  color,
  locked,
  pending,
  failed,
  submissionStatus,
  onPress,
  onDelete,
}: EntryRowProps) {
  const swipeRef = useRef<Swipeable>(null);

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
      enabled={!locked && !!onDelete}
    >
      <Pressable
        onPress={handlePress}
        disabled={locked}
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
            {phaseLabel ? (
              <Text style={styles.phase} numberOfLines={1}>
                {phaseLabel}
              </Text>
            ) : null}
            <SubmissionBadge status={submissionStatus ?? null} />
          </View>
          {memoPreview ? (
            <Text style={styles.memo} numberOfLines={1}>
              {memoPreview}
            </Text>
          ) : (
            <Text style={[styles.memo, styles.memoEmpty]}>No memo</Text>
          )}
          {failed ? (
            <Text style={styles.failedHint}>Failed to sync — tap to retry</Text>
          ) : pending ? (
            <Text style={styles.pendingHint}>Waiting to sync</Text>
          ) : null}
        </View>
        <View style={styles.right}>
          <Text style={styles.hours}>{formatHours(hours)}h</Text>
          {locked ? (
            <Ionicons name="lock-closed" size={16} color={colors.muted} />
          ) : failed ? (
            <Ionicons name="alert-circle" size={18} color={colors.danger} />
          ) : pending ? (
            <Ionicons name="cloud-upload-outline" size={16} color="#B45309" />
          ) : (
            <Ionicons name="pencil-outline" size={16} color={colors.muted} />
          )}
        </View>
      </Pressable>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
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
  },
  failedHint: {
    fontSize: 11,
    color: colors.danger,
    fontWeight: '600',
    marginTop: 2,
  },
  pendingHint: {
    fontSize: 11,
    color: '#B45309',
    fontWeight: '600',
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
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    flexShrink: 1,
  },
  phase: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    backgroundColor: colors.subtle,
  },
  memo: {
    fontSize: 13,
    color: colors.muted,
  },
  memoEmpty: {
    fontStyle: 'italic',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hours: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
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
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  deleteBtnPressed: {
    opacity: 0.85,
  },
  deleteText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
});

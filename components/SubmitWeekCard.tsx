import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { formatHours } from '../utils/dateHelpers';

interface SubmitWeekCardProps {
  draftHours: number;
  draftCount: number;
  /** Rows still on their way to the server: syncStatus pending or in_flight. */
  pendingCount: number;
  /** Rows the server rejected or that exhausted retries: syncStatus failed. */
  failedCount: number;
  submitting: boolean;
  onSubmit: () => void;
}

// Honest state labelling: a failed row is never described as "syncing".
// Failures block submission and are called out with their own line so the
// user knows to tap the red entry and fix it; only genuinely in-progress
// rows get the "still syncing" wording.
export function SubmitWeekCard({
  draftHours,
  draftCount,
  pendingCount,
  failedCount,
  submitting,
  onSubmit,
}: SubmitWeekCardProps) {
  const hasDrafts = draftCount > 0;
  const hasPending = pendingCount > 0;
  const hasFailed = failedCount > 0;
  const disabled = submitting || !hasDrafts || hasPending || hasFailed;

  if (!hasDrafts && !hasPending && !hasFailed) {
    return (
      <View style={[styles.card, styles.cardDone]}>
        <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
        <View style={styles.body}>
          <Text style={styles.doneTitle}>Week submitted</Text>
          <Text style={styles.doneSub}>Nothing left to submit for this week.</Text>
        </View>
      </View>
    );
  }

  const failedLine = hasFailed
    ? `${failedCount} failed — tap a red entry to fix`
    : null;
  const pendingLine = hasPending ? `${pendingCount} still syncing` : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.heading}>Ready to submit</Text>
        <Text style={styles.headingHours}>{formatHours(draftHours)}h</Text>
      </View>
      <Text style={styles.subHeading}>
        {draftCount} {draftCount === 1 ? 'entry' : 'entries'} saved as draft
        {pendingLine ? ` · ${pendingLine}` : ''}
      </Text>
      {failedLine ? <Text style={styles.failedLine}>{failedLine}</Text> : null}

      <Pressable
        onPress={onSubmit}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Submit week — ${draftCount} ${draftCount === 1 ? 'entry' : 'entries'}, ${formatHours(draftHours)} hours`}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.button,
          disabled && styles.buttonDisabled,
          pressed && !disabled && styles.buttonPressed,
        ]}
      >
        {submitting ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonText}>Submit Week</Text>
        )}
      </Pressable>

      <Text style={styles.hint}>
        {hasFailed
          ? 'Fix or delete the failed entries, then submit.'
          : hasPending
            ? 'Wait for syncing entries to finish, then submit.'
            : 'Once submitted, entries are locked for PM review.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 8,
  },
  cardDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  heading: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  headingHours: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.accent,
  },
  subHeading: {
    fontSize: 12,
    color: colors.muted,
  },
  failedLine: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.danger,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: 6,
  },
  buttonDisabled: {
    backgroundColor: colors.border,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  hint: {
    fontSize: 11,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 4,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  doneTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
  },
  doneSub: {
    fontSize: 12,
    color: colors.muted,
  },
});

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

interface SubmissionBadgeProps {
  status: string | null;
}

export function SubmissionBadge({ status }: SubmissionBadgeProps) {
  const normalized = (status ?? 'draft').toLowerCase();

  if (normalized === 'approved') {
    return (
      <View style={styles.approvedRow}>
        <Ionicons name="checkmark-circle" size={14} color={colors.accent} />
      </View>
    );
  }

  if (normalized === 'submitted') {
    return (
      <View style={[styles.pill, styles.pillSubmitted]}>
        <Text style={[styles.text, styles.textSubmitted]}>Submitted</Text>
      </View>
    );
  }

  if (normalized === 'rejected') {
    return (
      <View style={[styles.pill, styles.pillRejected]}>
        <Text style={[styles.text, styles.textRejected]}>Rejected</Text>
      </View>
    );
  }

  return (
    <View style={[styles.pill, styles.pillDraft]}>
      <Text style={[styles.text, styles.textDraft]}>Draft</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
  },
  text: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  pillDraft: {
    backgroundColor: colors.subtle,
    borderWidth: 1,
    borderColor: colors.border,
  },
  textDraft: {
    color: colors.muted,
  },
  pillSubmitted: {
    backgroundColor: colors.accentTint,
  },
  textSubmitted: {
    color: colors.accent,
  },
  pillRejected: {
    backgroundColor: '#FCE7E7',
  },
  textRejected: {
    color: colors.danger,
  },
  approvedRow: {
    paddingHorizontal: 2,
  },
});

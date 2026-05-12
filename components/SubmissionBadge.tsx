import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

interface SubmissionBadgeProps {
  status: string | null;
}

// Theme B submission badge. Sentence case (Draft / Submitted / Rejected),
// 10px / weight 500 / no caps — chrome that names the state, not chrome
// that shouts it. The label gets a soft tinted background that names the
// affect (neutral cream for Draft, accent tint for Submitted, warm red
// tint for Rejected). Approved is reduced to a single checkmark — once
// the entry is settled there's nothing more to say.
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
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  text: {
    fontSize: 10,
    fontWeight: '500',
  },
  // Draft: disabledBg cream-gray + textSecondary label. No border any more
  // — the tinted background carries the chip on its own, and the prior
  // hairline border read as visual noise next to the entry's hairline
  // card border.
  pillDraft: {
    backgroundColor: colors.disabledBg,
  },
  textDraft: {
    color: colors.textSecondary,
  },
  pillSubmitted: {
    backgroundColor: colors.accentTint,
  },
  textSubmitted: {
    color: colors.accent,
  },
  pillRejected: {
    backgroundColor: colors.dangerTint,
  },
  textRejected: {
    color: colors.danger,
  },
  approvedRow: {
    paddingHorizontal: 2,
  },
});

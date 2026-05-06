import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

export function OfflineBanner() {
  return (
    <View style={styles.banner}>
      <Ionicons name="cloud-offline-outline" size={14} color="#92400E" />
      <Text style={styles.text}>Offline — entries will sync when connected</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FEF3C7',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
    color: '#92400E',
  },
});

import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { useProjectStore } from '../store/useProjectStore';

interface ProjectPickerModalProps {
  visible: boolean;
  currentProjectId: string | null;
  onSelect: (projectId: string) => void;
  onClose: () => void;
}

export function ProjectPickerModal({
  visible,
  currentProjectId,
  onSelect,
  onClose,
}: ProjectPickerModalProps) {
  const tree = useProjectStore((s) => s.tree);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
    >
      <SafeAreaView style={styles.flex}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Choose project</Text>
          <View style={styles.cancelBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {tree.length === 0 ? (
            <Text style={styles.empty}>No projects available.</Text>
          ) : (
            tree.map((node) => {
              const selected = node.project.id === currentProjectId;
              return (
                <Pressable
                  key={node.project.id}
                  onPress={() => {
                    onSelect(node.project.id);
                    onClose();
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && styles.pressed,
                    selected && styles.rowSelected,
                  ]}
                >
                  <View
                    style={[styles.dot, { backgroundColor: node.project.color ?? colors.accent }]}
                  />
                  <View style={styles.body}>
                    <Text style={styles.name} numberOfLines={1}>
                      {node.project.name}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {node.phases.length === 0
                        ? 'No phases'
                        : `${node.phases.length} phase${node.phases.length === 1 ? '' : 's'}`}
                    </Text>
                  </View>
                  {selected ? (
                    <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
                  ) : null}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cancelBtn: {
    minWidth: 60,
    paddingVertical: 4,
  },
  cancelText: {
    fontSize: 15,
    color: colors.accent,
    fontWeight: '600',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
    gap: 8,
  },
  empty: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 32,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  rowSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentTint,
  },
  pressed: {
    opacity: 0.75,
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
  name: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  subtitle: {
    fontSize: 12,
    color: colors.muted,
  },
});

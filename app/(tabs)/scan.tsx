import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  CameraView,
  useCameraPermissions,
} from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../../theme';
import { TipCard } from '../../components/TipCard';
import { useScanStore } from '../../store/useScanStore';
import { useToastStore } from '../../store/useToastStore';
import { compressForUpload } from '../../services/scan/compress';

type FlashMode = 'off' | 'on';

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [flash, setFlash] = useState<FlashMode>('off');
  const [busy, setBusy] = useState(false);
  const setCaptured = useScanStore((s) => s.setCaptured);
  const showToast = useToastStore((s) => s.show);

  const handleCapture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        skipProcessing: false,
      });
      if (!photo?.uri) throw new Error('No image returned from camera');
      const compressed = await compressForUpload(photo.uri);
      setCaptured({
        base64: compressed.base64,
        width: compressed.width,
        height: compressed.height,
        source: 'camera',
        capturedAt: Date.now(),
      });
      router.push('/scan/processing');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not capture photo';
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePickFromLibrary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) {
        setBusy(false);
        return;
      }
      const compressed = await compressForUpload(result.assets[0].uri);
      setCaptured({
        base64: compressed.base64,
        width: compressed.width,
        height: compressed.height,
        source: 'library',
        capturedAt: Date.now(),
      });
      router.push('/scan/processing');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load photo';
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleFlash = () => {
    Haptics.selectionAsync().catch(() => {});
    setFlash((f) => (f === 'off' ? 'on' : 'off'));
  };

  if (!permission) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permissionWrap}>
        <View style={styles.permissionContent}>
          <View style={styles.permissionIconWrap}>
            <Ionicons name="camera-outline" size={36} color={colors.accent} />
          </View>
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionBody}>
            Jot uses your camera to scan handwritten timecards. We never store the
            photos on a server.
          </Text>

          <Pressable
            onPress={() =>
              permission.canAskAgain ? requestPermission() : Linking.openSettings()
            }
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed]}
          >
            <Text style={styles.primaryBtnText}>
              {permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
            </Text>
          </Pressable>

          <Pressable
            onPress={handlePickFromLibrary}
            disabled={busy}
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.btnPressed,
              busy && styles.btnDisabled,
            ]}
          >
            <Ionicons name="images-outline" size={18} color={colors.text} />
            <Text style={styles.secondaryBtnText}>Use photo library instead</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <View style={styles.cameraWrap}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="back"
          flash={flash}
        />
        <Pressable
          onPress={toggleFlash}
          style={({ pressed }) => [styles.flashToggle, pressed && styles.btnPressed]}
          accessibilityLabel={`Flash ${flash}`}
        >
          <Ionicons
            name={flash === 'on' ? 'flash' : 'flash-off'}
            size={20}
            color="#FFFFFF"
          />
        </Pressable>
        {busy ? (
          <View style={styles.busyOverlay}>
            <ActivityIndicator color="#FFFFFF" />
            <Text style={styles.busyText}>Preparing image…</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.controls}>
        <Pressable
          onPress={handlePickFromLibrary}
          disabled={busy}
          style={({ pressed }) => [
            styles.sideBtn,
            pressed && styles.btnPressed,
            busy && styles.btnDisabled,
          ]}
          accessibilityLabel="Pick from library"
        >
          <Ionicons name="images-outline" size={22} color={colors.text} />
        </Pressable>

        <Pressable
          onPress={handleCapture}
          disabled={busy}
          style={({ pressed }) => [
            styles.captureBtn,
            pressed && styles.captureBtnPressed,
            busy && styles.btnDisabled,
          ]}
          accessibilityLabel="Take photo"
        >
          <View style={styles.captureBtnInner} />
        </Pressable>

        <View style={styles.sideBtn} />
      </View>

      <View style={styles.tipWrap}>
        <TipCard />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraWrap: {
    flex: 1,
    margin: 16,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  flashToggle: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  busyText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  sideBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.subtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.background,
    borderWidth: 4,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureBtnPressed: {
    opacity: 0.85,
  },
  captureBtnInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
  },
  tipWrap: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  btnPressed: {
    opacity: 0.75,
  },
  btnDisabled: {
    opacity: 0.5,
  },

  permissionWrap: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  permissionContent: {
    alignItems: 'center',
    gap: 14,
  },
  permissionIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  permissionBody: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 14,
    minWidth: 200,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 200,
    justifyContent: 'center',
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
});

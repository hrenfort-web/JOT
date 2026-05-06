import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as AuthSession from 'expo-auth-session';
import {
  discovery,
  exchangeCodeForTokens,
  getAuthRequestConfig,
} from '../../services/bqe/auth';
import { fetchCurrentEmployee } from '../../services/bqe/employee';
import { useAuthStore } from '../../store/useAuthStore';
import { colors } from '../../theme';
import { formatError, logError } from '../../services/errors';
import { Ionicons } from '@expo/vector-icons';

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const clearSessionExpired = useAuthStore((s) => s.clearSessionExpired);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    getAuthRequestConfig(),
    discovery,
  );

  useEffect(() => {
    if (!response) return;

    if (response.type === 'success') {
      handleSuccess(response.params.code, request?.codeVerifier);
    } else if (response.type === 'error') {
      setError(response.error?.message ?? 'Authentication was rejected.');
      setLoading(false);
    } else if (response.type === 'cancel' || response.type === 'dismiss') {
      setLoading(false);
    }
  }, [response]);

  const handleSuccess = async (code: string, codeVerifier?: string) => {
    setLoading(true);
    setError(null);
    try {
      const tokens = await exchangeCodeForTokens(code, codeVerifier);
      const employee = await fetchCurrentEmployee(tokens);
      await login(tokens, employee);
      router.replace('/');
    } catch (e) {
      logError('login.exchange', e);
      setError(formatError(e).userMessage);
      setLoading(false);
    }
  };

  const onPress = async () => {
    setError(null);
    clearSessionExpired();
    setLoading(true);
    try {
      await promptAsync();
    } catch (e) {
      logError('login.prompt', e);
      setError("Couldn't open the BQE Core sign-in window. Please try again.");
      setLoading(false);
    }
  };

  const disabled = loading || !request;

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <Text style={styles.title}>Jot</Text>
        <Text style={styles.tagline}>Jot it. Done.</Text>
      </View>

      {sessionExpired ? (
        <View style={styles.banner}>
          <Ionicons name="time-outline" size={16} color="#92400E" />
          <Text style={styles.bannerText}>
            Your session expired — please sign in again.
          </Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          disabled={disabled}
          style={({ pressed }) => [
            styles.button,
            disabled && styles.buttonDisabled,
            pressed && !disabled && styles.buttonPressed,
          ]}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Connect to BQE Core</Text>
          )}
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 32,
    justifyContent: 'space-between',
    paddingTop: 96,
    paddingBottom: 64,
  },
  brand: {
    alignItems: 'center',
  },
  title: {
    fontSize: 48,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -1,
  },
  tagline: {
    marginTop: 8,
    fontSize: 16,
    color: colors.muted,
  },
  actions: {
    gap: 16,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#B91C1C',
    textAlign: 'center',
    fontSize: 14,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#92400E',
  },
});

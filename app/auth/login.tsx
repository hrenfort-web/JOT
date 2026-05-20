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
import { colors, FONT_HANDWRITING } from '../../theme';
import { formatError, logError } from '../../services/errors';
import { Ionicons } from '@expo/vector-icons';

export default function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const loginAsDemo = useAuthStore((s) => s.loginAsDemo);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const clearSessionExpired = useAuthStore((s) => s.clearSessionExpired);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    getAuthRequestConfig(),
    discovery,
  );

  useEffect(() => {
    if (!__DEV__ || !request) return;
    console.log('[jot:auth] ──── AuthRequest ────');
    console.log('[jot:auth] clientId =', request.clientId);
    console.log('[jot:auth] redirectUri =', request.redirectUri);
    console.log('[jot:auth] scopes =', request.scopes);
    console.log('[jot:auth] responseType =', request.responseType);
    console.log('[jot:auth] state =', request.state);
    console.log('[jot:auth] codeChallenge =', request.codeChallenge);
    console.log('[jot:auth] codeChallengeMethod =', request.codeChallengeMethod);
    console.log('[jot:auth] codeVerifier (first 8) =', request.codeVerifier?.slice(0, 8));
    console.log('[jot:auth] FULL authorize URL =', request.url);
  }, [request]);

  useEffect(() => {
    if (!response) return;

    if (__DEV__) {
      console.log('[jot:auth] ──── AuthResponse ────');
      console.log('[jot:auth] response.type =', response.type);
      if (response.type === 'success' || response.type === 'error') {
        console.log('[jot:auth] response.params =', response.params);
        console.log('[jot:auth] response.url =', response.url);
      }
      if (response.type === 'error') {
        console.log('[jot:auth] response.error =', response.error);
        console.log('[jot:auth] response.errorCode =', response.errorCode);
      }
    }

    if (response.type === 'success') {
      handleSuccess(response.params.code);
    } else if (response.type === 'error') {
      setError(response.error?.message ?? 'Authentication was rejected.');
      setLoading(false);
    } else if (response.type === 'cancel' || response.type === 'dismiss') {
      setLoading(false);
    }
  }, [response]);

  const handleSuccess = async (code: string) => {
    setLoading(true);
    setError(null);
    try {
      const tokens = await exchangeCodeForTokens(code);
      const employee = await fetchCurrentEmployee(tokens);
      await login(tokens, employee);
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
      setError("Couldn't open the sign-in window. Please try again.");
      setLoading(false);
    }
  };

  const onPressDemo = async () => {
    setError(null);
    clearSessionExpired();
    setDemoLoading(true);
    try {
      await loginAsDemo();
      router.replace('/');
    } catch (e) {
      logError('login.demo', e);
      setError("Couldn't load the demo data.");
      setDemoLoading(false);
    }
  };

  const disabled = loading || !request;
  const demoDisabled = demoLoading || loading;
  const demoEnabled =
    __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DEMO_MODE === 'true';

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        {/*
          Theme B wordmark — "Jot it." in Architects Daughter, with only
          the period coloured accent. The period is the entire brand
          punch: small, deliberate, the visual equivalent of "done".
          The 24px gap below puts breathing room before the prose
          tagline. Don't add a third tone — it dilutes the accent.
        */}
        <Text style={styles.wordmark}>
          Jot<Text style={styles.wordmarkPeriod}>.</Text>
        </Text>
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
            <ActivityIndicator color={colors.surface} />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </Pressable>

        {demoEnabled ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={onPressDemo}
              disabled={demoDisabled}
              style={({ pressed }) => [
                styles.demoButton,
                demoDisabled && styles.buttonDisabled,
                pressed && !demoDisabled && styles.buttonPressed,
              ]}
            >
              {demoLoading ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={styles.demoButtonText}>Explore Demo</Text>
              )}
            </Pressable>
            <Text style={styles.demoHint}>Try the app with sample data</Text>
          </>
        ) : null}

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
    // Wordmark sits in the upper-middle third; button anchors near the
    // bottom. space-between distributes naturally given the paddings.
    justifyContent: 'space-between',
    paddingTop: 96,
    paddingBottom: 64,
  },
  brand: {
    alignItems: 'center',
  },
  wordmark: {
    fontFamily: FONT_HANDWRITING,
    // 72px is large enough that the handwriting reads as character, not
    // decoration. Negative letter-spacing tightened the prior Helvetica
    // wordmark; for the handwriting font the natural spacing is correct
    // — no kerning adjustment.
    fontSize: 72,
    color: colors.text,
    lineHeight: 80,
    textAlign: 'center',
  },
  wordmarkPeriod: {
    fontFamily: FONT_HANDWRITING,
    fontSize: 72,
    color: colors.accent,
  },
  tagline: {
    // Architects Daughter, secondary tone — the calm handwritten echo of
    // the hero. No accent anywhere: the hero "Jot." dot is the single
    // orange signature, so the tagline stays entirely in textSecondary.
    marginTop: 24,
    fontFamily: FONT_HANDWRITING,
    fontSize: 24,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  actions: {
    gap: 16,
  },
  button: {
    backgroundColor: colors.accent,
    // Pill — radius = height/2.
    borderRadius: 28,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: {
    backgroundColor: colors.accentPressed,
  },
  buttonDisabled: {
    backgroundColor: colors.disabledBg,
  },
  buttonText: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: '500',
  },
  demoButton: {
    backgroundColor: colors.surface,
    borderRadius: 24,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  demoButtonText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '500',
  },
  demoHint: {
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: 'center',
    marginTop: -8,
  },
  error: {
    color: colors.danger,
    textAlign: 'center',
    fontSize: 14,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.warningTint,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: '#92400E',
  },
});

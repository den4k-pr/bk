import { useState, useContext, useRef, useEffect } from 'react';

import { AuthContext } from '../../context/AuthContext';
import { getAuthErrorCode, getAuthErrorField, getAuthErrorMessage } from '../../utils/authErrors';
import { AppDispatch, RootState } from '../../../store';
import { useDispatch, useSelector } from 'react-redux';
import { updateLevel } from '../../services/authService';
import { setLevel } from '../../features/levelSlice';
import { checkPromoCode, describePromo, normalizePromoInput, promoErrorMessage } from '../../services/promoService';

export type PromoCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'valid'; text: string }
  | { status: 'invalid'; text: string };

const EMAIL_REGEX = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const MIN_PASSWORD_LENGTH = 6;

export const useRegisterLogic = () => {
  const { register } = useContext(AuthContext);
  const dispatch = useDispatch<AppDispatch>();
  const selectedLevel = useSelector((state: RootState) => state.level.selectedLevel);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; general?: string }>({});

  // Необов'язковий промокод: перевіряється одразу після введення, а
  // остаточно — сервером під час створення акаунта.
  const [promoCode, setPromoCodeRaw] = useState('');
  const [promoCheck, setPromoCheck] = useState<PromoCheckState>({ status: 'idle' });
  const promoRequestRef = useRef(0);

  const setPromoCode = (value: string) => {
    setPromoCodeRaw(normalizePromoInput(value));
    promoRequestRef.current += 1;
    setPromoCheck({ status: 'idle' });
  };

  const verifyPromoCode = async () => {
    const code = normalizePromoInput(promoCode);
    if (!code) {
      setPromoCheck({ status: 'idle' });
      return;
    }
    const requestId = ++promoRequestRef.current;
    setPromoCheck({ status: 'checking' });
    try {
      const summary = await checkPromoCode(code);
      if (!isMountedRef.current || requestId !== promoRequestRef.current) return;
      setPromoCheck({ status: 'valid', text: describePromo(summary) });
    } catch (err: any) {
      if (!isMountedRef.current || requestId !== promoRequestRef.current) return;
      setPromoCheck({
        status: 'invalid',
        text: promoErrorMessage(err) ?? getAuthErrorMessage(err, 'Не вдалося перевірити промокод'),
      });
    }
  };

  // 🟢 НОВЕ: та сама причина, що й у useLoginForm.ts — успішна
  // реєстрація одразу перемикає RootNavigation на AppStack і розмонтовує
  // цей екран/хук, поки `register(...)` (включно з опційним updateLevel
  // всередині onSuccess) ще завершується.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleRegister = async () => {
    setSubmitted(true);
    setErrors({});

    const emailTrimmed = email.trim();
    const passwordTrimmed = password.trim();

    // Твоя оригінальна валідація
    const validationErrors: { email?: string; password?: string } = {};
    if (!emailTrimmed) {
      validationErrors.email = 'Пошта не може бути порожньою';
    } else if (!EMAIL_REGEX.test(emailTrimmed)) {
      validationErrors.email = 'Введіть коректну адресу пошти';
    }
    if (!passwordTrimmed) {
      validationErrors.password = 'Пароль не може бути порожнім';
    } else if (passwordTrimmed.length < MIN_PASSWORD_LENGTH) {
      validationErrors.password = `Пароль має містити не менше ${MIN_PASSWORD_LENGTH} символів`;
    }

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    try {
      setLoading(true);

      await register(emailTrimmed, passwordTrimmed, async () => {
        if (selectedLevel) {
          try {
            await updateLevel(selectedLevel);
          } catch (levelErr) {
            console.error('Помилка оновлення рівня після реєстрації:', levelErr);
          }
        }
        dispatch(setLevel(''));
      }, normalizePromoInput(promoCode) || undefined);
    } catch (err: any) {
      if (!isMountedRef.current) return;

      // Точний текст від сервера ("Акаунт з таким email вже існує",
      // помилка формату пошти/пароля тощо) — під відповідним полем.
      // Недійсний промокод: акаунт не створено, причина — під полем промокоду.
      const promoMessage = promoErrorMessage(err);
      if (promoMessage) {
        setPromoCheck({ status: 'invalid', text: promoMessage });
        return;
      }

      const message = getAuthErrorMessage(err, 'Щось пішло не так. Спробуйте пізніше.');
      const field = getAuthErrorField(getAuthErrorCode(err));
      setErrors(field ? { [field]: message } : { general: message });
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  return {
    email, setEmail,
    password, setPassword,
    loading, submitted, errors,
    handleRegister, setErrors, dispatch,
    promoCode, setPromoCode, promoCheck, verifyPromoCode,
  };
};
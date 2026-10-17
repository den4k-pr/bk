import { useState, useContext, useRef, useEffect } from 'react';
import { AuthContext } from '../../context/AuthContext';
import { getAuthErrorCode, getAuthErrorField, getAuthErrorMessage } from '../../utils/authErrors';

const EMAIL_REGEX = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const MIN_PASSWORD_LENGTH = 6;

export const useLoginLogic = () => {
  const { login } = useContext(AuthContext);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; general?: string; }>({});

  // 🟢 НОВЕ: захист від "Can't perform a React state update on an
  // unmounted component". Реальний сценарій, не теоретичний: при
  // УСПІШНОМУ логіні AuthContext одразу ставить user -> RootNavigation
  // перемикається на AppStack -> LoginForm (і цей хук разом з ним)
  // РОЗМОНТОВУЄТЬСЯ. Але `await login(...)` у try все ще виконується
  // на цей момент, і `finally { setLoading(false) }` спрацьовує вже
  // ПІСЛЯ розмонтування. На старих/повільних JS-рушіях (типово — старші
  // iPhone на iOS 11-12) такі "запізнілі" setState під час навігаційного
  // переходу — поширене джерело зайвого навантаження й попереджень, що
  // на слабкому пристрої може відчутно накластись на й так важкий кадр
  // переходу між екранами.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleLogin = async () => {
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
      console.log('Клієнтська валідація НЕ пройдена:', validationErrors);
      setErrors(validationErrors);
      return;
    }

    console.log('Клієнтська валідація пройдена. Спроба логіну на сервері...');

    try {
      setLoading(true);
      await login(emailTrimmed, passwordTrimmed);
    } catch (err: any) {
      if (!isMountedRef.current) return;

      // Точний текст від сервера: "Акаунт з таким email не знайдено" /
      // "Невірний пароль" / помилка формату тощо — під відповідним полем.
      const message = getAuthErrorMessage(err, 'Щось пішло не так, спробуйте пізніше');
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
    loading, errors, submitted,
    handleLogin, setErrors
  };
};
import { useState, useEffect, useRef, useCallback, useContext } from "react";
import { debounce } from "lodash";
import { getNotifications, updateNotifications } from "../services/settingsService";
import { AuthContext } from "../context/AuthContext";

export const useNotificationSettings = (visibleMessage: boolean) => {
  const { user, refreshUser } = useContext(AuthContext);

  const [isRemind, _setIsRemind] = useState(false);
  const [isWordOfDay, _setIsWordOfDay] = useState(false);
  const [isEmail, _setIsEmail] = useState(false);

  const [isLoaded, setIsLoaded] = useState(false);
  // Починаємо з лоадерами, як у вашій оригінальній логіці
  const [loadingRemind, setLoadingRemind] = useState(true);
  const [loadingWord, setLoadingWord] = useState(true);
  const [loadingEmail, setLoadingEmail] = useState(true);

  const hasChanges = useRef(false);
  const isInitialLoad = useRef(true);

  const loadSettings = useCallback(async () => {
    if (!visibleMessage || !user) return;

    hasChanges.current = false;
    isInitialLoad.current = true;

    // 1. Негайно встановлюємо кешовані дані
    if (user && user.learningNotification !== undefined) {
      _setIsRemind(user.learningNotification);
      _setIsWordOfDay(user.wordDayNotification);
      _setIsEmail(user.emailNotification);
    }

    // 2. Встановлюємо UI в "завантажено", але лоадери залишаємо
    // Це покаже кешовані значення, але з індикаторами завантаження
    setIsLoaded(true);
    setLoadingRemind(true);
    setLoadingWord(true);
    setLoadingEmail(true);

    // 3. Фонова ревалідація
    try {
      const data = await getNotifications();

      // 4. Перевіряємо, чи юзер не вніс зміни, поки ми вантажили
      if (hasChanges.current) {
        console.log("🏃 Юзер вніс зміни, фонове оновлення скасовано.");
        isInitialLoad.current = false;
        // Все одно вимикаємо лоадери
        setTimeout(() => {
          setLoadingRemind(false);
          setLoadingWord(false);
          setLoadingEmail(false);
        }, 300);
        return;
      }

      // 5. Оновлюємо стан свіжими даними
      _setIsRemind(data.learningReminder);
      _setIsWordOfDay(data.wordOfTheDay);
      _setIsEmail(data.emailNewsletter);

    } catch (e) {
      console.error("❌ Помилка фонового завантаження сповіщень:", e);
    } finally {
      // 6. Завершуємо завантаження
      isInitialLoad.current = false;
      setTimeout(() => {
        setLoadingRemind(false);
        setLoadingWord(false);
        setLoadingEmail(false);
      }, 300);
    }
  }, [visibleMessage, user]);

  const debouncedSave = useCallback(
    debounce(async (settings) => {
      try {
        await updateNotifications(settings);
        console.log("✅ Дані оновлено на сервері.");
        if (refreshUser) {
          await refreshUser();
          console.log("🔄 Дані користувача в AuthContext оновлено.");
        }
        hasChanges.current = false;
      } catch (e) {
        console.error("❌ Помилка збереження:", e);
      }
    }, 1000),
    [refreshUser]
  );

  const setIsRemind = (value: boolean) => {
    hasChanges.current = true;
    _setIsRemind(value);
  };
  const setIsWordOfDay = (value: boolean) => {
    hasChanges.current = true;
    _setIsWordOfDay(value);
  };
  const setIsEmail = (value: boolean) => {
    hasChanges.current = true;
    _setIsEmail(value);
  };

  useEffect(() => {
    if (isInitialLoad.current) {
      return;
    }

    if (hasChanges.current) {
      const settings = {
        learningReminder: isRemind,
        wordOfTheDay: isWordOfDay,
        emailNewsletter: isEmail,
      };
      console.log("⏳ Зміни зафіксовано, очікуємо на збереження...");
      debouncedSave(settings);
    }
  }, [isRemind, isWordOfDay, isEmail, debouncedSave]);

  useEffect(() => {
    return () => {
      if (hasChanges.current) {
        console.log("🏃‍♂️ Модальне вікно закривається, примусово відправляємо зміни...");
        debouncedSave.flush();
      } else {
        debouncedSave.cancel();
      }
    };
  }, [debouncedSave]);

  const resetLoaders = useCallback(() => {
    isInitialLoad.current = true;
    setIsLoaded(false);
    setLoadingRemind(true);
    setLoadingWord(true);
    setLoadingEmail(true);
    hasChanges.current = false;
  }, []);

  return {
    isLoaded,
    isRemind,
    isWordOfDay,
    isEmail,
    loadingRemind,
    loadingWord,
    loadingEmail,
    setIsRemind,
    setIsWordOfDay,
    setIsEmail,
    loadSettings,
    resetLoaders,
  };
};
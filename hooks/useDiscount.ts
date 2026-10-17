import { useState, useEffect } from "react";
import { getDiscountById } from "../services/settingsService";
import { Discount } from "../types/auth";

export const useDiscount = () => {
  const [discount, setDiscount] = useState<Discount | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true; // прапорець, щоб уникнути оновлення після розмонтування

    const fetchDiscount = async () => {
      try {
        const data = await getDiscountById();
        if (data && isMounted) {
          setDiscount(data);
        }
      } catch (error) {
        console.error("Помилка при отриманні знижки:", error);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchDiscount();

    return () => {
      isMounted = false; // при розмонтуванні компоненту
    };
  }, []);

  return { discount, loading };
};

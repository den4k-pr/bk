import { useState, useCallback } from "react";

export const useRandomImage = (images: any[]) => {
  const [image, setImage] = useState<any>(
    images.length > 0 ? images[Math.floor(Math.random() * images.length)] : null
  );

  const refreshImage = useCallback(() => {
    if (images.length === 0) return;
    let newImage;
    do {
      newImage = images[Math.floor(Math.random() * images.length)];
    } while (newImage === image && images.length > 1); // щоб не повторюватися
    setImage(newImage);
  }, [images, image]);

  return { image, refreshImage };
};

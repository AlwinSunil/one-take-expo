import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, type VideoThumbnail } from 'expo-video';

function ThumbnailImage({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  const [thumb, setThumb] = useState<VideoThumbnail | null>(null);
  useEffect(() => {
    let active = true;
    player.generateThumbnailsAsync(0.1, { maxWidth: 320 }).then(
      frames => { if (active) setThumb(frames[0] ?? null); },
      () => {},
    );
    return () => { active = false; };
  }, [player]);
  if (!thumb) return <View className="flex-1 bg-neutral-800" />;
  return <Image source={thumb} contentFit="cover" style={{ flex: 1 }} />;
}

export function ProjectThumbnail({ uri }: { uri: string | null }) {
  return <View className="w-full bg-neutral-800" style={{ aspectRatio: 16 / 9 }}>
    {uri ? <ThumbnailImage uri={uri} /> : <View className="flex-1 items-center justify-center">
      <Text className="text-neutral-500 text-xs">No preview</Text>
    </View>}
  </View>;
}

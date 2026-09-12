import { Link } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Home() {
  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-5 pt-10 pb-6 w-full max-w-[480px] self-center">
        <View className="flex-1 justify-center">
          <Text className="text-white text-3xl font-bold text-center">One Take</Text>
          <Text className="text-neutral-400 text-xs mt-2 text-center">Choose how you want to record.</Text>

          <View className="mt-8 gap-3">
            <Link href="/script" asChild>
              <Pressable className="bg-neutral-900 border border-neutral-800 rounded-2xl px-5 py-5 active:opacity-70">
                <Text className="text-white text-base font-bold text-center">Script Mode</Text>
                <Text className="text-neutral-500 text-xs text-center mt-1">Record with a teleprompter</Text>
              </Pressable>
            </Link>
            <Link href={{ pathname: '/camera', params: { mode: 'assisted' } }} asChild>
              <Pressable className="bg-neutral-900 border border-neutral-800 rounded-2xl px-5 py-5 active:opacity-80">
                <Text className="text-white text-base font-bold text-center">Assisted Mode</Text>
                <Text className="text-neutral-500 text-xs text-center mt-1">Speak naturally with live transcript</Text>
              </Pressable>
            </Link>
          </View>
        </View>
        <Link href="/projects" asChild>
          <Pressable className="rounded-xl px-4 py-3 active:opacity-70">
            <Text className="text-neutral-400 text-xs font-medium text-center">Projects</Text>
          </Pressable>
        </Link>

        <Text className="text-neutral-600 text-[11px] mt-auto text-center">
          English-only V1 · Android · NPU on Snapdragon
        </Text>
      </View>
    </SafeAreaView>
  );
}

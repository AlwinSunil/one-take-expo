import { Link } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Clapperboard, Mic, Images } from 'lucide-react-native';

const DevelopmentSessions = __DEV__ ? require('../development/sessions/session-runner').default : null;

const MediaResearch = __DEV__ ? require('../development/sessions/media-research').default : null;

function ModeRow({ title, sub, icon: Icon }: { title: string; sub: string; icon: typeof Mic }) {
  return (
    <View className="flex-row items-center px-5 py-5">
      <Icon size={22} strokeWidth={1.75} color="#a3a3a3" />
      <View className="flex-1 ml-4">
        <Text className="text-white text-base font-bold">{title}</Text>
        <Text className="text-neutral-500 text-xs mt-0.5">{sub}</Text>
      </View>
      <ChevronRight size={20} strokeWidth={1.75} color="#737373" />
    </View>
  );
}

export default function Home() {
  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-6 pt-10 pb-8 w-full max-w-[480px] self-center">
        <View className="flex-1 justify-center">
          <Text className="text-neutral-500 text-[11px] tracking-[1px] text-center">ONE TAKE</Text>
          <Text className="text-white text-[40px] leading-[44px] font-bold text-center mt-3">
            Shoot it once.
          </Text>
          <Text className="text-neutral-500 text-sm mt-3 text-center">
            Pick a mode and record.
          </Text>

          <View className="mt-10 mb-6 rounded-2xl overflow-hidden bg-neutral-900 border border-neutral-800">
            <Link href="/script" asChild>
              <Pressable className="active:bg-neutral-800">
                <ModeRow title="Script Mode" sub="Record with a teleprompter" icon={Clapperboard} />
              </Pressable>
            </Link>
            <View className="h-px bg-neutral-800" />
            <Link href={{ pathname: '/camera', params: { mode: 'assisted' } }} asChild>
              <Pressable className="active:bg-neutral-800">
                <ModeRow title="Assisted Mode" sub="Speak naturally with live transcript" icon={Mic} />
              </Pressable>
            </Link>
          </View>
        </View>

        <Link href="/projects" asChild>
          <Pressable className="bg-neutral-900 border border-neutral-800 rounded-2xl active:bg-neutral-800">
            <View className="flex-row items-center justify-center px-5 py-4">
              <Images size={18} strokeWidth={1.75} color="#d4d4d4" />
              <Text className="text-neutral-200 text-sm font-semibold ml-2">Projects</Text>
            </View>
          </Pressable>
        </Link>
        {DevelopmentSessions && <DevelopmentSessions />}
        {MediaResearch && <MediaResearch />}
      </View>
    </SafeAreaView>
  );
}

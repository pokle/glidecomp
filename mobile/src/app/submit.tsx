import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

export default function Submit() {
  return (
    <Screen>
      <StageNote stage={5}>The submit form arrives in stage 5.</StageNote>
    </Screen>
  );
}

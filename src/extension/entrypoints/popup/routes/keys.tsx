import { TbTrash } from 'solid-icons/tb';
import { Layout } from '../components/layout';
import { Header } from '../components/header';
import { Cell } from '../components/cell';
import { appStorage, KeyInfo } from '@/utils/storage';
import { KeysList } from '../components/keys-list';

export const Keys = () => {
  const [keys, setKeys] = createSignal<KeyInfo[]>([]);

  onMount(async () => {
    const keys = await appStorage.allKeys.getValue();
    if (keys) setKeys(keys);
  });

  const clearKeys = async () => {
    await appStorage.allKeys.clear();
    await appStorage.keys.setValue([]);
    setKeys([]);
  };

  return (
    <Layout>
      <Header backHref="/">Keys</Header>
      <div class="flex flex-col gap-3">
        <Cell before={<TbTrash />} variant="danger" onClick={clearKeys}>
          Clear keys
        </Cell>
        <KeysList keys={keys} />
      </div>
    </Layout>
  );
};

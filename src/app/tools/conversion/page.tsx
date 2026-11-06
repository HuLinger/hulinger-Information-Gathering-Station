import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ConversionWorkbench from '../../../components/tools/ConversionWorkbench';
import { AuthError, requireUser } from '../../../server/authorize';

export const dynamic = 'force-dynamic';
export const metadata = { title: '格式转换 · Hulinger' };

export default async function ConversionPage() {
  try { await requireUser(await headers()); }
  catch (error) {
    if (error instanceof AuthError) redirect('/login');
    throw error;
  }
  return <ConversionWorkbench />;
}

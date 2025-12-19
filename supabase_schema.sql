-- このSQLをSupabaseの「SQL Editor」に貼り付けて「Run」を押してください

-- テーブル作成
create table public.projects (
  id bigint primary key, -- Date.now()の値を使用するためbigint
  name text not null,
  client text,
  date text not null, -- 'YYYY-MM-DD'形式の文字列
  sales integer default 0,
  expenses integer default 0,
  note text,
  is_invoiced boolean default false,
  is_paid boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Row Level Security (RLS) の有効化（セキュリティ設定）
alter table public.projects enable row level security;

-- ポリシー作成（今回はテスト用として、全ユーザーに読み書きを許可する設定にします）
-- 本番運用でユーザー認証を入れる場合は、ここを 'auth.uid() = user_id' などに変更します。
create policy "Enable all access for anon users" on public.projects
  for all using (true) with check (true);

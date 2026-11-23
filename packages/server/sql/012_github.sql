create table github_connections (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null unique references workspaces(id) on delete cascade,
  actor_id         uuid not null references actors(id) on delete cascade,
  organization     text not null,
  secret           text not null,
  routes           jsonb not null,
  last_delivery_at timestamptz,
  last_posted_at   timestamptz
);

create table github_deliveries (
  connection_id uuid not null references github_connections(id) on delete cascade,
  delivery_id   uuid not null,
  primary key (connection_id, delivery_id)
);

alter table notifications
  drop constraint notifications_kind_check,
  add constraint notifications_kind_check
    check (kind in ('mention','reply','task','agent','system','github'));

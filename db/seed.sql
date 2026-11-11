-- Seed rows for the tracker (safe to re-run: existing rows are left alone).
-- Generated from data/neighborhood.json. Opted out by default: G6016, G6032, P15301
insert into lightshow.nodes (id, kind, participating) values
  ('G6003','house',true),
  ('G6004','house',true),
  ('G6005','house',true),
  ('G6006','house',true),
  ('G6007','house',true),
  ('G6008','house',true),
  ('G6009','house',true),
  ('G6010','house',true),
  ('G6011','house',true),
  ('G6012','house',true),
  ('G6013','house',true),
  ('G6014','house',true),
  ('G6015','house',true),
  ('G6016','house',false),
  ('G6017','house',true),
  ('G6018','house',true),
  ('G6019','house',true),
  ('G6020','house',true),
  ('G6021','house',true),
  ('G6022','house',true),
  ('G6023','house',true),
  ('G6024','house',true),
  ('G6026','house',true),
  ('G6028','house',true),
  ('G6030','house',true),
  ('G6032','house',false),
  ('G6034','house',true),
  ('G6035','house',true),
  ('G6036','house',true),
  ('G6037','house',true),
  ('G6038','house',true),
  ('G6039','house',true),
  ('G6041','house',true),
  ('G6043','house',true),
  ('P15301','house',false),
  ('P15302','house',true),
  ('P15304','house',true),
  ('P15305','house',true),
  ('P15306','house',true),
  ('P15307','house',true),
  ('P15308','house',true),
  ('P15309','house',true),
  ('P15310','house',true),
  ('P15311','house',true),
  ('P15312','house',true),
  ('P15313','house',true),
  ('P15314','house',true),
  ('P15315','house',true),
  ('P15316','house',true),
  ('P15317','house',true),
  ('P15318','house',true),
  ('P15319','house',true),
  ('P15321','house',true),
  ('P15323','house',true),
  ('P15325','house',true),
  ('P15327','house',true),
  ('I-front','island',true),
  ('I-glade','island',true),
  ('I-park','island',true)
on conflict (id) do nothing;

insert into lightshow.tasks (label, sort)
select 'Music streaming website up and running', 0
where not exists (select 1 from lightshow.tasks);

-- Island setup items with their sub-items. A parent that already exists (same label, top level)
-- is skipped along with its sub-items, so this is safe to run again. Sort numbers keep each
-- parent next to its sub-items.
with parents (label, sort) as (values
  ('Set up Glade island', 1),
  ('Set up Star Wars island', 5),
  ('Set up Paloma Park island', 9)
), added as (
  insert into lightshow.tasks (label, sort)
  select p.label, p.sort from parents p
  where not exists (select 1 from lightshow.tasks t where t.label = p.label and t.parent_id is null)
  returning id, label
)
insert into lightshow.tasks (label, sort, parent_id)
select c.label, c.sort, a.id
from (values
  ('Set up Glade island', 'Set up train', 2),
  ('Set up Glade island', 'Put lights on tree', 3),
  ('Set up Glade island', 'Put big bulb in tree', 4),
  ('Set up Star Wars island', 'Put up lightsabers', 6),
  ('Set up Star Wars island', 'Put up mannequins', 7),
  ('Set up Star Wars island', 'Put up blow-ups', 8)
) as c (parent, label, sort)
join added a on a.label = c.parent;

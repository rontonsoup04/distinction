-- Migration 8: a second, broader similarity group for every course, and many more courses (UNSW first).
-- Questions reach tutors whose course shares EITHER group with the question's course, at any uni.
-- Safe to re-run.

alter table public.courses add column if not exists similar_group_2 text;
create index if not exists courses_group2_idx on public.courses (similar_group_2);

-- Are two courses similar? True when they share their specific topic or their broad discipline.
create or replace function public.courses_similar(u1 text, c1 text, u2 text, c2 text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from courses a, courses b
    where a.uni_id = u1 and a.code = c1 and b.uni_id = u2 and b.code = c2
      and (   (a.similar_group   is not null and (a.similar_group   = b.similar_group or a.similar_group   = b.similar_group_2))
           or (a.similar_group_2 is not null and (a.similar_group_2 = b.similar_group or a.similar_group_2 = b.similar_group_2)))
  );
$$;

create or replace function public.tutor_can_answer(t uuid, q_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.questions q
    join public.profiles p on p.id = t
    where q.id = q_id
      and q.asker_id <> t
      and p.tutor_status = 'approved'
      and (not q.verified_only or p.equals_verified)
      and exists (
        select 1 from public.tutor_courses tc
        where tc.tutor_id = t and tc.status = 'approved' and tc.mark >= q.min_mark
          and ((tc.uni_id = q.uni_id and tc.code = q.course_code)
               or (q.wide and public.courses_similar(q.uni_id, q.course_code, tc.uni_id, tc.code)))
      )
  );
$$;

create or replace function public.tutor_feed()
returns table (
  id uuid, uni_id text, course_code text, course_title text, body text,
  attachment_path text, attachment_name text, attachment_type text, attachment_size int,
  min_mark int, verified_only boolean, wide boolean, urgent boolean, slots int,
  expires_at timestamptz, created_at timestamptz, asker_name text,
  answer_count int, held_by_others int, my_position int, my_payout numeric,
  my_claim_expires timestamptz, match_uni text, match_code text
)
language sql stable security definer set search_path = public as $$
  select q.id, q.uni_id, q.course_code,
         coalesce((select title from courses c where c.uni_id = q.uni_id and c.code = q.course_code), ''),
         q.body, q.attachment_path, q.attachment_name, q.attachment_type, q.attachment_size,
         q.min_mark, q.verified_only, q.wide, q.urgent, q.slots, q.expires_at, q.created_at,
         coalesce(nullif(p.display_name, ''), split_part(coalesce(p.full_name, 'Student'), ' ', 1)),
         (select count(*)::int from answers a where a.question_id = q.id),
         (select count(*)::int from claims cl where cl.question_id = q.id and cl.tutor_id <> auth.uid() and cl.expires_at > now()),
         (select a.position from answers a where a.question_id = q.id and a.tutor_id = auth.uid()),
         (select a.payout from answers a where a.question_id = q.id and a.tutor_id = auth.uid()),
         (select cl.expires_at from claims cl where cl.question_id = q.id and cl.tutor_id = auth.uid() and cl.expires_at > now()),
         m.uni_id, m.code
  from questions q
  join profiles p on p.id = q.asker_id
  left join lateral (
    select tc.uni_id, tc.code from tutor_courses tc
    where tc.tutor_id = auth.uid() and tc.status = 'approved' and tc.mark >= q.min_mark
      and ((tc.uni_id = q.uni_id and tc.code = q.course_code)
           or (q.wide and public.courses_similar(q.uni_id, q.course_code, tc.uni_id, tc.code)))
    order by (tc.uni_id = q.uni_id and tc.code = q.course_code) desc, tc.mark desc
    limit 1
  ) m on true
  where public.tutor_can_answer(auth.uid(), q.id)
    and (q.expires_at > now()
         or exists (select 1 from answers a where a.question_id = q.id and a.tutor_id = auth.uid()
                    and a.created_at > now() - interval '3 days'))
  order by q.created_at desc
  limit 100;
$$;

create or replace function public.question_reach(p_uni text, p_code text, p_min int, p_verified boolean, p_wide boolean)
returns int
language sql stable security definer set search_path = public as $$
  select count(distinct tc.tutor_id)::int
  from tutor_courses tc join profiles p on p.id = tc.tutor_id
  where tc.status = 'approved' and p.tutor_status = 'approved' and tc.mark >= p_min
    and (not p_verified or p.equals_verified) and tc.tutor_id <> auth.uid()
    and ((tc.uni_id = p_uni and tc.code = p_code)
         or (p_wide and public.courses_similar(p_uni, p_code, tc.uni_id, tc.code)));
$$;

-- New UNSW courses (typed by students or read from transcripts) get a broad discipline from their code prefix
create or replace function public.course_default_group() returns trigger
language plpgsql as $$
begin
  if new.similar_group_2 is null and new.uni_id = 'UNSW' then
    new.similar_group_2 := case left(new.code, 4) when 'COMP' then 'computing' when 'SENG' then 'computing' when 'INFS' then 'information_systems' when 'ACCT' then 'accounting' when 'TABL' then 'accounting' when 'FINS' then 'finance' when 'ECON' then 'economics' when 'COMM' then 'business' when 'MGMT' then 'management' when 'MARK' then 'marketing' when 'ACTL' then 'actuarial' when 'MATH' then 'mathematics' when 'PHYS' then 'physics' when 'CHEM' then 'chemistry' when 'BABS' then 'biology' when 'BIOS' then 'biology' when 'PSYC' then 'psychology' when 'LAWS' then 'law' when 'ENGG' then 'engineering' when 'ELEC' then 'electrical_eng' when 'TELE' then 'electrical_eng' when 'MMAN' then 'mechanical_eng' when 'CVEN' then 'civil_eng' end;
  end if;
  return new;
end $$;
drop trigger if exists course_default_group on public.courses;
create trigger course_default_group before insert on public.courses
  for each row execute function public.course_default_group();

-- Courses

insert into public.courses (uni_id, code, title, similar_group, similar_group_2, source) select v.uni_id, v.code, v.title, v.g1, v.g2, 'seed' from (values
  ('UNSW', 'COMP1010', 'The Art of Computing', null, 'computing'),
  ('UNSW', 'COMP1511', 'Programming Fundamentals', 'prog', 'computing'),
  ('UNSW', 'COMP1521', 'Computer Systems Fundamentals', 'sys', 'computing'),
  ('UNSW', 'COMP1531', 'Software Engineering Fundamentals', 'se', 'computing'),
  ('UNSW', 'COMP2041', 'Software Construction: Techniques and Tools', null, 'computing'),
  ('UNSW', 'COMP2511', 'Object-Oriented Design and Programming', 'oop', 'computing'),
  ('UNSW', 'COMP2521', 'Data Structures and Algorithms', 'dsa', 'computing'),
  ('UNSW', 'COMP3121', 'Algorithm Design and Analysis', 'algo', 'computing'),
  ('UNSW', 'COMP3131', 'Programming Languages and Compilers', null, 'computing'),
  ('UNSW', 'COMP3141', 'Software System Design and Implementation', null, 'computing'),
  ('UNSW', 'COMP3151', 'Foundations of Concurrency', null, 'computing'),
  ('UNSW', 'COMP3211', 'Computer Architecture', 'sys', 'computing'),
  ('UNSW', 'COMP3231', 'Operating Systems', 'os', 'computing'),
  ('UNSW', 'COMP3311', 'Database Systems', 'db', 'information_systems'),
  ('UNSW', 'COMP3331', 'Computer Networks and Applications', 'net', 'computing'),
  ('UNSW', 'COMP3411', 'Artificial Intelligence', 'ai', 'computing'),
  ('UNSW', 'COMP3421', 'Computer Graphics', null, 'computing'),
  ('UNSW', 'COMP3511', 'Human Computer Interaction', 'hci', 'computing'),
  ('UNSW', 'COMP3821', 'Extended Algorithm Design and Analysis', 'algo', 'computing'),
  ('UNSW', 'COMP3900', 'Computer Science Project', null, 'computing'),
  ('UNSW', 'COMP4128', 'Programming Challenges', null, 'computing'),
  ('UNSW', 'COMP4920', 'Professional Issues and Ethics in Information Technology', null, 'computing'),
  ('UNSW', 'COMP6080', 'Web Front-End Programming', 'web', 'computing'),
  ('UNSW', 'COMP6441', 'Security Engineering and Cyber Security', 'security', 'computing'),
  ('UNSW', 'COMP6443', 'Web Application Security and Testing', 'security', 'computing'),
  ('UNSW', 'COMP6447', 'System and Software Security Assessment', 'security', 'computing'),
  ('UNSW', 'COMP6771', 'Advanced C++ Programming', null, 'computing'),
  ('UNSW', 'COMP6991', 'Solving Modern Programming Problems with Rust', null, 'computing'),
  ('UNSW', 'COMP9021', 'Principles of Programming', 'prog', 'computing'),
  ('UNSW', 'COMP9024', 'Data Structures and Algorithms', 'dsa', 'computing'),
  ('UNSW', 'COMP9311', 'Database Systems', 'db', 'information_systems'),
  ('UNSW', 'COMP9321', 'Data Services Engineering', null, 'computing'),
  ('UNSW', 'COMP9331', 'Computer Networks and Applications', 'net', 'computing'),
  ('UNSW', 'COMP9414', 'Artificial Intelligence', 'ai', 'computing'),
  ('UNSW', 'COMP9417', 'Machine Learning and Data Mining', 'ml', 'computing'),
  ('UNSW', 'COMP9444', 'Neural Networks and Deep Learning', 'ml', 'computing'),
  ('UNSW', 'COMP9517', 'Computer Vision', null, 'computing'),
  ('UNSW', 'COMP9900', 'Information Technology Project', null, 'computing'),
  ('UNSW', 'SENG2021', 'Requirements and Design Workshop', null, 'computing'),
  ('UNSW', 'SENG3011', 'Software Engineering Workshop 3', null, 'computing'),
  ('UNSW', 'INFS1602', 'Digital Transformation in Business', 'is', 'information_systems'),
  ('UNSW', 'INFS1603', 'Business Databases', 'db', 'information_systems'),
  ('UNSW', 'INFS1609', 'Fundamentals of Business Programming', 'oop', 'computing'),
  ('UNSW', 'INFS2603', 'Business Analysis', 'ba', 'information_systems'),
  ('UNSW', 'INFS2605', 'Intermediate Business Programming', 'oop', 'computing'),
  ('UNSW', 'INFS2608', 'Database Management and Big Data Infrastructures', 'db', 'information_systems'),
  ('UNSW', 'INFS2621', 'Enterprise Systems', 'is', 'information_systems'),
  ('UNSW', 'INFS3603', 'Business Analytics Methods', 'analytics', 'information_systems'),
  ('UNSW', 'INFS3604', 'Business Process Management', 'bpm', 'information_systems'),
  ('UNSW', 'INFS3605', 'Information Systems Innovation and Transformation', 'is', 'information_systems'),
  ('UNSW', 'INFS3617', 'Networking and Cyber Security', 'net', 'computing'),
  ('UNSW', 'INFS3634', 'Mobile Applications Development', null, 'information_systems'),
  ('UNSW', 'INFS3830', 'Social Media and Analytics', 'analytics', 'information_systems'),
  ('UNSW', 'ACCT1501', 'Accounting and Financial Management 1A', 'acct', 'accounting'),
  ('UNSW', 'ACCT1511', 'Accounting and Financial Management 1B', 'acct2', 'accounting'),
  ('UNSW', 'ACCT2522', 'Management Accounting 1', 'mgmtacct', 'accounting'),
  ('UNSW', 'ACCT2542', 'Corporate Financial Reporting', 'finrep', 'accounting'),
  ('UNSW', 'ACCT3563', 'Issues in Financial Reporting and Analysis', 'finrep', 'accounting'),
  ('UNSW', 'ACCT3583', 'Strategic Value Management', null, 'accounting'),
  ('UNSW', 'ACCT3610', 'Business Analysis and Valuation', null, 'accounting'),
  ('UNSW', 'TABL1710', 'Business and the Law', 'bizlaw', 'law'),
  ('UNSW', 'TABL2751', 'Business Taxation', 'tax', 'accounting'),
  ('UNSW', 'FINS1612', 'Capital Markets and Institutions', null, 'finance'),
  ('UNSW', 'FINS1613', 'Business Finance', 'fin', 'finance'),
  ('UNSW', 'FINS2615', 'Intermediate Business Finance', 'corpfin', 'finance'),
  ('UNSW', 'FINS2618', 'Investments', 'invest', 'finance'),
  ('UNSW', 'FINS2624', 'Portfolio Management', 'invest', 'finance'),
  ('UNSW', 'FINS3616', 'International Business Finance', null, 'finance'),
  ('UNSW', 'FINS3630', 'Bank Financial Management', null, 'finance'),
  ('UNSW', 'FINS3635', 'Options, Futures and Risk-Management Techniques', null, 'finance'),
  ('UNSW', 'FINS3641', 'Security Analysis and Valuation', 'invest', 'finance'),
  ('UNSW', 'ECON1101', 'Microeconomics 1', 'micro', 'economics'),
  ('UNSW', 'ECON1102', 'Macroeconomics 1', 'macro', 'economics'),
  ('UNSW', 'ECON1203', 'Business and Economic Statistics', 'stats', 'statistics'),
  ('UNSW', 'ECON2101', 'Microeconomics 2', 'micro2', 'economics'),
  ('UNSW', 'ECON2102', 'Macroeconomics 2', 'macro2', 'economics'),
  ('UNSW', 'ECON2112', 'Game Theory and Business Strategy', null, 'economics'),
  ('UNSW', 'ECON2206', 'Introductory Econometrics', 'econometrics', 'economics'),
  ('UNSW', 'ECON3203', 'Econometric Theory and Methods', 'econometrics', 'economics'),
  ('UNSW', 'COMM1100', 'Business Decision Making', 'business', 'business'),
  ('UNSW', 'COMM1110', 'Evidence-Based Problem Solving', 'business', 'business'),
  ('UNSW', 'COMM1120', 'Collaboration and Innovation in Business', 'business', 'business'),
  ('UNSW', 'COMM1140', 'Financial Management', 'business', 'business'),
  ('UNSW', 'COMM1150', 'Global Business Environments', 'business', 'business'),
  ('UNSW', 'COMM1170', 'Organisational Resources', 'business', 'business'),
  ('UNSW', 'COMM1180', 'Value Creation', 'business', 'business'),
  ('UNSW', 'COMM1190', 'Data, Insights and Decisions', 'business', 'business'),
  ('UNSW', 'MGMT1001', 'Managing Organisations and People', 'orgbehav', 'management'),
  ('UNSW', 'MARK1012', 'Marketing Fundamentals', 'mkt', 'marketing'),
  ('UNSW', 'MARK2051', 'Consumer Behaviour', null, 'marketing'),
  ('UNSW', 'ACTL1101', 'Introduction to Actuarial Studies', 'actuarial', 'actuarial'),
  ('UNSW', 'ACTL2111', 'Financial Mathematics for Actuaries', 'actuarial', 'actuarial'),
  ('UNSW', 'ACTL2131', 'Probability and Mathematical Statistics', 'stats2', 'statistics'),
  ('UNSW', 'MATH1031', 'Mathematics for Life Sciences', 'calc', 'mathematics'),
  ('UNSW', 'MATH1041', 'Statistics for Life and Social Sciences', 'stats', 'statistics'),
  ('UNSW', 'MATH1081', 'Discrete Mathematics', 'discrete', 'mathematics'),
  ('UNSW', 'MATH1131', 'Mathematics 1A', 'calc', 'mathematics'),
  ('UNSW', 'MATH1141', 'Higher Mathematics 1A', 'calc', 'mathematics'),
  ('UNSW', 'MATH1151', 'Mathematics for Actuarial Studies and Finance 1A', 'calc', 'mathematics'),
  ('UNSW', 'MATH1231', 'Mathematics 1B', 'calc2', 'mathematics'),
  ('UNSW', 'MATH1241', 'Higher Mathematics 1B', 'calc2', 'mathematics'),
  ('UNSW', 'MATH1251', 'Mathematics for Actuarial Studies and Finance 1B', 'calc2', 'mathematics'),
  ('UNSW', 'MATH2011', 'Several Variable Calculus', 'calc3', 'mathematics'),
  ('UNSW', 'MATH2069', 'Mathematics 2A', 'calc3', 'mathematics'),
  ('UNSW', 'MATH2089', 'Numerical Methods and Statistics', null, 'mathematics'),
  ('UNSW', 'MATH2099', 'Mathematics 2B', 'linalg', 'mathematics'),
  ('UNSW', 'MATH2121', 'Theory and Applications of Differential Equations', null, 'mathematics'),
  ('UNSW', 'MATH2400', 'Finite Mathematics', 'discrete', 'mathematics'),
  ('UNSW', 'MATH2501', 'Linear Algebra', 'linalg', 'mathematics'),
  ('UNSW', 'MATH2601', 'Higher Linear Algebra', 'linalg', 'mathematics'),
  ('UNSW', 'MATH2801', 'Theory of Statistics', 'stats2', 'statistics'),
  ('UNSW', 'MATH2831', 'Linear Models', 'stats2', 'statistics'),
  ('UNSW', 'MATH2901', 'Higher Theory of Statistics', 'stats2', 'statistics'),
  ('UNSW', 'PHYS1121', 'Physics 1A', 'phys', 'physics'),
  ('UNSW', 'PHYS1131', 'Higher Physics 1A', 'phys', 'physics'),
  ('UNSW', 'PHYS1221', 'Physics 1B', 'phys', 'physics'),
  ('UNSW', 'PHYS1231', 'Higher Physics 1B', 'phys', 'physics'),
  ('UNSW', 'PHYS1160', 'Introduction to Astronomy', null, 'physics'),
  ('UNSW', 'CHEM1011', 'Chemistry A', 'chem', 'chemistry'),
  ('UNSW', 'CHEM1021', 'Chemistry B', 'chem', 'chemistry'),
  ('UNSW', 'CHEM1031', 'Higher Chemistry A', 'chem', 'chemistry'),
  ('UNSW', 'CHEM1041', 'Higher Chemistry B', 'chem', 'chemistry'),
  ('UNSW', 'BABS1201', 'Molecules, Cells and Genes', 'bio', 'biology'),
  ('UNSW', 'BIOS1101', 'Evolutionary and Functional Biology', 'bio', 'biology'),
  ('UNSW', 'PSYC1001', 'Psychology 1A', 'psych', 'psychology'),
  ('UNSW', 'PSYC1011', 'Psychology 1B', 'psych', 'psychology'),
  ('UNSW', 'PSYC2001', 'Research Methods 2', 'psychrm', 'psychology'),
  ('UNSW', 'PSYC2061', 'Social and Developmental Psychology', null, 'psychology'),
  ('UNSW', 'PSYC2071', 'Perception and Cognition', null, 'psychology'),
  ('UNSW', 'LAWS1052', 'Introducing Law and Justice', 'law', 'law'),
  ('UNSW', 'LAWS1061', 'Torts', 'law', 'law'),
  ('UNSW', 'ENGG1000', 'Introduction to Engineering Design and Innovation', null, 'engineering'),
  ('UNSW', 'ENGG1300', 'Engineering Mechanics', 'mech1', 'engineering'),
  ('UNSW', 'ENGG1811', 'Computing for Engineers', 'prog', 'computing'),
  ('UNSW', 'ENGG2400', 'Mechanics of Solids 1', null, 'engineering'),
  ('UNSW', 'ENGG2500', 'Fluid Mechanics for Engineers', null, 'engineering'),
  ('UNSW', 'ELEC1111', 'Electrical Circuit Fundamentals', 'circuits', 'electrical_eng'),
  ('UNSW', 'ELEC2134', 'Circuits and Signals', 'circuits', 'electrical_eng'),
  ('UNSW', 'ELEC2141', 'Digital Circuit Design', null, 'electrical_eng'),
  ('UNSW', 'TELE3113', 'Analogue and Digital Communications', null, 'electrical_eng'),
  ('UNSW', 'MMAN1130', 'Design and Manufacturing', null, 'mechanical_eng'),
  ('UNSW', 'MMAN2100', 'Engineering Design 2', null, 'mechanical_eng'),
  ('UNSW', 'MMAN2300', 'Engineering Mechanics 2', 'mech1', 'engineering'),
  ('UNSW', 'MMAN2700', 'Thermodynamics', null, 'mechanical_eng'),
  ('UNSW', 'CVEN1701', 'Environmental Principles and Systems', null, 'civil_eng'),
  ('UNSW', 'CVEN2101', 'Engineering Construction', null, 'civil_eng'),
  ('UNSW', 'CVEN2301', 'Mechanics of Solids', null, 'civil_eng'),
  ('UNSW', 'CVEN2303', 'Structural Analysis and Modelling', null, 'civil_eng'),
  ('UNSW', 'CVEN2501', 'Principles of Water Engineering', null, 'civil_eng'),
  ('USYD', 'COMP2022', 'Models of Computation', null, null),
  ('USYD', 'COMP3027', 'Algorithm Design', 'algo', 'computing'),
  ('USYD', 'COMP3308', 'Introduction to Artificial Intelligence', 'ai', 'computing'),
  ('USYD', 'COMP5318', 'Machine Learning and Data Mining', 'ml', 'computing'),
  ('USYD', 'ISYS2120', 'Data and Information Management', 'db', 'information_systems'),
  ('USYD', 'MATH1004', 'Discrete Mathematics', 'discrete', 'mathematics'),
  ('USYD', 'MATH1005', 'Statistical Thinking with Data', 'stats', 'statistics'),
  ('USYD', 'MATH1064', 'Discrete Mathematics for Computation', 'discrete', 'mathematics'),
  ('USYD', 'STAT2011', 'Probability and Estimation Theory', 'stats2', 'statistics'),
  ('USYD', 'ECON2001', 'Intermediate Microeconomics', 'micro2', 'economics'),
  ('USYD', 'ECON2002', 'Intermediate Macroeconomics', 'macro2', 'economics'),
  ('USYD', 'MKTG1001', 'Marketing Principles', 'mkt', 'marketing'),
  ('USYD', 'QBUS2310', 'Management Science', null, null),
  ('USYD', 'QBUS2820', 'Predictive Analytics', 'analytics', 'information_systems'),
  ('USYD', 'PSYC1002', 'Psychology 1002', 'psych', 'psychology'),
  ('UTS', '31269', 'Business Requirements Modelling', 'ba', 'information_systems'),
  ('UTS', '41092', 'Network Fundamentals', 'net', 'computing'),
  ('MQ', 'COMP2010', 'Algorithms and Data Structures', 'dsa', 'computing'),
  ('MONASH', 'FIT1043', 'Introduction to Data Science', null, null),
  ('MONASH', 'FIT2014', 'Theory of Computation', null, null),
  ('MONASH', 'FIT2099', 'Object-Oriented Design and Implementation', 'oop', 'computing'),
  ('MONASH', 'FIT2100', 'Operating Systems', 'os', 'computing'),
  ('MONASH', 'FIT2107', 'Software Quality and Testing', 'se', 'computing'),
  ('MONASH', 'FIT3077', 'Software Engineering: Architecture and Design', 'se', 'computing'),
  ('MONASH', 'FIT3152', 'Data Analytics', 'analytics', 'information_systems'),
  ('MONASH', 'FIT3155', 'Advanced Data Structures and Algorithms', 'algo', 'computing'),
  ('MONASH', 'FIT2086', 'Modelling for Data Analysis', 'stats2', 'statistics'),
  ('MONASH', 'FIT3080', 'Intelligent Systems', 'ai', 'computing'),
  ('MONASH', 'ETC2410', 'Introductory Econometrics', 'econometrics', 'economics'),
  ('MONASH', 'ECC2000', 'Intermediate Microeconomics', 'micro2', 'economics'),
  ('UNIMELB', 'COMP20007', 'Design of Algorithms', 'algo', 'computing'),
  ('UNIMELB', 'COMP30024', 'Artificial Intelligence', 'ai', 'computing'),
  ('UNIMELB', 'COMP30027', 'Machine Learning', 'ml', 'computing'),
  ('UNIMELB', 'COMP30023', 'Computer Systems', 'os', 'computing'),
  ('UNIMELB', 'SWEN20003', 'Object Oriented Software Development', 'oop', 'computing'),
  ('UNIMELB', 'MAST20004', 'Probability', 'stats2', 'statistics'),
  ('UNIMELB', 'MAST20005', 'Statistics', 'stats2', 'statistics'),
  ('UNIMELB', 'MAST20009', 'Vector Calculus', 'calc3', 'mathematics'),
  ('UNIMELB', 'ECON20001', 'Intermediate Macroeconomics', 'macro2', 'economics'),
  ('UNIMELB', 'ECON20002', 'Intermediate Microeconomics', 'micro2', 'economics'),
  ('UNIMELB', 'ECOM20001', 'Econometrics 1', 'econometrics', 'economics'),
  ('UNIMELB', 'FNCE20005', 'Corporate Financial Decision Making', 'corpfin', 'finance'),
  ('UQ', 'CSSE2310', 'Computer Systems Principles and Programming', 'sys', 'computing'),
  ('UQ', 'COMP3702', 'Artificial Intelligence', 'ai', 'computing'),
  ('UQ', 'INFS2200', 'Relational Database Systems', 'db', 'information_systems'),
  ('UQ', 'ECON2010', 'Intermediate Microeconomics', 'micro2', 'economics'),
  ('UQ', 'ECON2020', 'Intermediate Macroeconomics', 'macro2', 'economics'),
  ('UQ', 'ECON2300', 'Introductory Econometrics', 'econometrics', 'economics'),
  ('ANU', 'COMP2300', 'Computer Organisation and Program Execution', 'sys', 'computing'),
  ('ANU', 'COMP2310', 'Systems, Networks and Concurrency', null, null),
  ('ANU', 'COMP3600', 'Algorithms', 'algo', 'computing'),
  ('ANU', 'COMP3620', 'Artificial Intelligence', 'ai', 'computing'),
  ('ANU', 'COMP3670', 'Introduction to Machine Learning', 'ml', 'computing'),
  ('ANU', 'ECON2101', 'Microeconomics 2', 'micro2', 'economics'),
  ('ANU', 'ECON2102', 'Macroeconomics 2', 'macro2', 'economics'),
  ('ANU', 'EMET2007', 'Econometrics I', 'econometrics', 'economics'),
  ('ANU', 'STAT2001', 'Introductory Mathematical Statistics', 'stats2', 'statistics'),
  ('QUT', 'CAB203', 'Discrete Structures', 'discrete', 'mathematics'),
  ('QUT', 'CAB301', 'Algorithms and Complexity', 'algo', 'computing'),
  ('QUT', 'CAB302', 'Software Development', 'se', 'computing'),
  ('QUT', 'CAB320', 'Artificial Intelligence', 'ai', 'computing'),
  ('UWA', 'CITS2002', 'Systems Programming', 'sys', 'computing'),
  ('UWA', 'CITS2005', 'Object Oriented Programming', 'oop', 'computing'),
  ('UWA', 'CITS3001', 'Algorithms, Agents and Artificial Intelligence', 'ai', 'computing'),
  ('UWA', 'CITS3002', 'Computer Networks', 'net', 'computing')
) as v(uni_id, code, title, g1, g2)
on conflict (uni_id, code) do update set
  title = case when public.courses.title = '' or public.courses.source = 'seed' then excluded.title else public.courses.title end,
  similar_group = coalesce(excluded.similar_group, public.courses.similar_group),
  similar_group_2 = coalesce(excluded.similar_group_2, public.courses.similar_group_2);

-- Broad discipline for existing courses that only had a specific topic
update public.courses set similar_group_2 = case similar_group when 'prog' then 'computing' when 'oop' then 'computing' when 'dsa' then 'computing' when 'algo' then 'computing' when 'sys' then 'computing' when 'os' then 'computing' when 'net' then 'computing' when 'se' then 'computing' when 'web' then 'computing' when 'ai' then 'computing' when 'ml' then 'computing' when 'hci' then 'computing' when 'security' then 'computing' when 'discrete' then 'mathematics' when 'db' then 'information_systems' when 'is' then 'information_systems' when 'ba' then 'information_systems' when 'bpm' then 'information_systems' when 'analytics' then 'information_systems' when 'micro' then 'economics' when 'macro' then 'economics' when 'micro2' then 'economics' when 'macro2' then 'economics' when 'econometrics' then 'economics' when 'stats' then 'statistics' when 'stats2' then 'statistics' when 'acct' then 'accounting' when 'acct2' then 'accounting' when 'mgmtacct' then 'accounting' when 'finrep' then 'accounting' when 'tax' then 'accounting' when 'fin' then 'finance' when 'corpfin' then 'finance' when 'invest' then 'finance' when 'mkt' then 'marketing' when 'mgmt' then 'management' when 'orgbehav' then 'management' when 'bizlaw' then 'law' when 'law' then 'law' when 'calc' then 'mathematics' when 'calc2' then 'mathematics' when 'calc3' then 'mathematics' when 'linalg' then 'mathematics' when 'phys' then 'physics' when 'chem' then 'chemistry' when 'bio' then 'biology' when 'psych' then 'psychology' when 'psychrm' then 'psychology' when 'circuits' then 'electrical_eng' when 'mech1' then 'engineering' when 'actuarial' then 'actuarial' when 'business' then 'business' end
where similar_group_2 is null and similar_group is not null;

-- UNSW courses added by students or transcripts: discipline from the code prefix
update public.courses set similar_group_2 = case left(code, 4) when 'COMP' then 'computing' when 'SENG' then 'computing' when 'INFS' then 'information_systems' when 'ACCT' then 'accounting' when 'TABL' then 'accounting' when 'FINS' then 'finance' when 'ECON' then 'economics' when 'COMM' then 'business' when 'MGMT' then 'management' when 'MARK' then 'marketing' when 'ACTL' then 'actuarial' when 'MATH' then 'mathematics' when 'PHYS' then 'physics' when 'CHEM' then 'chemistry' when 'BABS' then 'biology' when 'BIOS' then 'biology' when 'PSYC' then 'psychology' when 'LAWS' then 'law' when 'ENGG' then 'engineering' when 'ELEC' then 'electrical_eng' when 'TELE' then 'electrical_eng' when 'MMAN' then 'mechanical_eng' when 'CVEN' then 'civil_eng' end
where uni_id = 'UNSW' and similar_group_2 is null;

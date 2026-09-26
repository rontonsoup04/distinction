# Generates migration_08_more_courses.sql
# similar_group   = specific topic, equivalent courses across unis (e.g. intro programming)
# similar_group_2 = broad discipline (e.g. computing), widens who sees a question
G2 = {  # topic -> discipline
 "prog":"computing","oop":"computing","dsa":"computing","algo":"computing","sys":"computing","os":"computing","net":"computing","se":"computing",
 "web":"computing","ai":"computing","ml":"computing","hci":"computing","security":"computing","discrete":"mathematics",
 "db":"information_systems","is":"information_systems","ba":"information_systems","bpm":"information_systems","analytics":"information_systems",
 "micro":"economics","macro":"economics","micro2":"economics","macro2":"economics","econometrics":"economics",
 "stats":"statistics","stats2":"statistics","acct":"accounting","acct2":"accounting","mgmtacct":"accounting","finrep":"accounting","tax":"accounting",
 "fin":"finance","corpfin":"finance","invest":"finance","mkt":"marketing","mgmt":"management","orgbehav":"management","bizlaw":"law","law":"law",
 "calc":"mathematics","calc2":"mathematics","calc3":"mathematics","linalg":"mathematics","phys":"physics","chem":"chemistry","bio":"biology",
 "psych":"psychology","psychrm":"psychology","circuits":"electrical_eng","mech1":"engineering","actuarial":"actuarial","business":"business",
}
PREFIX = {"COMP":"computing","SENG":"computing","INFS":"information_systems","ACCT":"accounting","TABL":"accounting","FINS":"finance","ECON":"economics",
 "COMM":"business","MGMT":"management","MARK":"marketing","ACTL":"actuarial","MATH":"mathematics","PHYS":"physics","CHEM":"chemistry","BABS":"biology",
 "BIOS":"biology","PSYC":"psychology","LAWS":"law","ENGG":"engineering","ELEC":"electrical_eng","TELE":"electrical_eng","MMAN":"mechanical_eng","CVEN":"civil_eng"}
UNSW = """COMP1010|The Art of Computing|
COMP1511|Programming Fundamentals|prog
COMP1521|Computer Systems Fundamentals|sys
COMP1531|Software Engineering Fundamentals|se
COMP2041|Software Construction: Techniques and Tools|
COMP2511|Object-Oriented Design and Programming|oop
COMP2521|Data Structures and Algorithms|dsa
COMP3121|Algorithm Design and Analysis|algo
COMP3131|Programming Languages and Compilers|
COMP3141|Software System Design and Implementation|
COMP3151|Foundations of Concurrency|
COMP3211|Computer Architecture|sys
COMP3231|Operating Systems|os
COMP3311|Database Systems|db
COMP3331|Computer Networks and Applications|net
COMP3411|Artificial Intelligence|ai
COMP3421|Computer Graphics|
COMP3511|Human Computer Interaction|hci
COMP3821|Extended Algorithm Design and Analysis|algo
COMP3900|Computer Science Project|
COMP4128|Programming Challenges|
COMP4920|Professional Issues and Ethics in Information Technology|
COMP6080|Web Front-End Programming|web
COMP6441|Security Engineering and Cyber Security|security
COMP6443|Web Application Security and Testing|security
COMP6447|System and Software Security Assessment|security
COMP6771|Advanced C++ Programming|
COMP6991|Solving Modern Programming Problems with Rust|
COMP9021|Principles of Programming|prog
COMP9024|Data Structures and Algorithms|dsa
COMP9311|Database Systems|db
COMP9321|Data Services Engineering|
COMP9331|Computer Networks and Applications|net
COMP9414|Artificial Intelligence|ai
COMP9417|Machine Learning and Data Mining|ml
COMP9444|Neural Networks and Deep Learning|ml
COMP9517|Computer Vision|
COMP9900|Information Technology Project|
SENG2021|Requirements and Design Workshop|
SENG3011|Software Engineering Workshop 3|
INFS1602|Digital Transformation in Business|is
INFS1603|Business Databases|db
INFS1609|Fundamentals of Business Programming|oop
INFS2603|Business Analysis|ba
INFS2605|Intermediate Business Programming|oop
INFS2608|Database Management and Big Data Infrastructures|db
INFS2621|Enterprise Systems|is
INFS3603|Business Analytics Methods|analytics
INFS3604|Business Process Management|bpm
INFS3605|Information Systems Innovation and Transformation|is
INFS3617|Networking and Cyber Security|net
INFS3634|Mobile Applications Development|
INFS3830|Social Media and Analytics|analytics
ACCT1501|Accounting and Financial Management 1A|acct
ACCT1511|Accounting and Financial Management 1B|acct2
ACCT2522|Management Accounting 1|mgmtacct
ACCT2542|Corporate Financial Reporting|finrep
ACCT3563|Issues in Financial Reporting and Analysis|finrep
ACCT3583|Strategic Value Management|
ACCT3610|Business Analysis and Valuation|
TABL1710|Business and the Law|bizlaw
TABL2751|Business Taxation|tax
FINS1612|Capital Markets and Institutions|
FINS1613|Business Finance|fin
FINS2615|Intermediate Business Finance|corpfin
FINS2618|Investments|invest
FINS2624|Portfolio Management|invest
FINS3616|International Business Finance|
FINS3630|Bank Financial Management|
FINS3635|Options, Futures and Risk-Management Techniques|
FINS3641|Security Analysis and Valuation|invest
ECON1101|Microeconomics 1|micro
ECON1102|Macroeconomics 1|macro
ECON1203|Business and Economic Statistics|stats
ECON2101|Microeconomics 2|micro2
ECON2102|Macroeconomics 2|macro2
ECON2112|Game Theory and Business Strategy|
ECON2206|Introductory Econometrics|econometrics
ECON3203|Econometric Theory and Methods|econometrics
COMM1100|Business Decision Making|business
COMM1110|Evidence-Based Problem Solving|business
COMM1120|Collaboration and Innovation in Business|business
COMM1140|Financial Management|business
COMM1150|Global Business Environments|business
COMM1170|Organisational Resources|business
COMM1180|Value Creation|business
COMM1190|Data, Insights and Decisions|business
MGMT1001|Managing Organisations and People|orgbehav
MARK1012|Marketing Fundamentals|mkt
MARK2051|Consumer Behaviour|
ACTL1101|Introduction to Actuarial Studies|actuarial
ACTL2111|Financial Mathematics for Actuaries|actuarial
ACTL2131|Probability and Mathematical Statistics|stats2
MATH1031|Mathematics for Life Sciences|calc
MATH1041|Statistics for Life and Social Sciences|stats
MATH1081|Discrete Mathematics|discrete
MATH1131|Mathematics 1A|calc
MATH1141|Higher Mathematics 1A|calc
MATH1151|Mathematics for Actuarial Studies and Finance 1A|calc
MATH1231|Mathematics 1B|calc2
MATH1241|Higher Mathematics 1B|calc2
MATH1251|Mathematics for Actuarial Studies and Finance 1B|calc2
MATH2011|Several Variable Calculus|calc3
MATH2069|Mathematics 2A|calc3
MATH2089|Numerical Methods and Statistics|
MATH2099|Mathematics 2B|linalg
MATH2121|Theory and Applications of Differential Equations|
MATH2400|Finite Mathematics|discrete
MATH2501|Linear Algebra|linalg
MATH2601|Higher Linear Algebra|linalg
MATH2801|Theory of Statistics|stats2
MATH2831|Linear Models|stats2
MATH2901|Higher Theory of Statistics|stats2
PHYS1121|Physics 1A|phys
PHYS1131|Higher Physics 1A|phys
PHYS1221|Physics 1B|phys
PHYS1231|Higher Physics 1B|phys
PHYS1160|Introduction to Astronomy|
CHEM1011|Chemistry A|chem
CHEM1021|Chemistry B|chem
CHEM1031|Higher Chemistry A|chem
CHEM1041|Higher Chemistry B|chem
BABS1201|Molecules, Cells and Genes|bio
BIOS1101|Evolutionary and Functional Biology|bio
PSYC1001|Psychology 1A|psych
PSYC1011|Psychology 1B|psych
PSYC2001|Research Methods 2|psychrm
PSYC2061|Social and Developmental Psychology|
PSYC2071|Perception and Cognition|
LAWS1052|Introducing Law and Justice|law
LAWS1061|Torts|law
ENGG1000|Introduction to Engineering Design and Innovation|
ENGG1300|Engineering Mechanics|mech1
ENGG1811|Computing for Engineers|prog
ENGG2400|Mechanics of Solids 1|
ENGG2500|Fluid Mechanics for Engineers|
ELEC1111|Electrical Circuit Fundamentals|circuits
ELEC2134|Circuits and Signals|circuits
ELEC2141|Digital Circuit Design|
TELE3113|Analogue and Digital Communications|
MMAN1130|Design and Manufacturing|
MMAN2100|Engineering Design 2|
MMAN2300|Engineering Mechanics 2|mech1
MMAN2700|Thermodynamics|
CVEN1701|Environmental Principles and Systems|
CVEN2101|Engineering Construction|
CVEN2301|Mechanics of Solids|
CVEN2303|Structural Analysis and Modelling|
CVEN2501|Principles of Water Engineering|"""
OTHER = {
 "USYD": """COMP2022|Models of Computation|
COMP3027|Algorithm Design|algo
COMP3308|Introduction to Artificial Intelligence|ai
COMP5318|Machine Learning and Data Mining|ml
ISYS2120|Data and Information Management|db
MATH1004|Discrete Mathematics|discrete
MATH1005|Statistical Thinking with Data|stats
MATH1064|Discrete Mathematics for Computation|discrete
STAT2011|Probability and Estimation Theory|stats2
ECON2001|Intermediate Microeconomics|micro2
ECON2002|Intermediate Macroeconomics|macro2
MKTG1001|Marketing Principles|mkt
QBUS2310|Management Science|
QBUS2820|Predictive Analytics|analytics
PSYC1002|Psychology 1002|psych""",
 "UTS": """31269|Business Requirements Modelling|ba
41092|Network Fundamentals|net""",
 "MQ": """COMP2010|Algorithms and Data Structures|dsa""",
 "MONASH": """FIT1043|Introduction to Data Science|
FIT2014|Theory of Computation|
FIT2099|Object-Oriented Design and Implementation|oop
FIT2100|Operating Systems|os
FIT2107|Software Quality and Testing|se
FIT3077|Software Engineering: Architecture and Design|se
FIT3152|Data Analytics|analytics
FIT3155|Advanced Data Structures and Algorithms|algo
FIT2086|Modelling for Data Analysis|stats2
FIT3080|Intelligent Systems|ai
ETC2410|Introductory Econometrics|econometrics
ECC2000|Intermediate Microeconomics|micro2""",
 "UNIMELB": """COMP20007|Design of Algorithms|algo
COMP30024|Artificial Intelligence|ai
COMP30027|Machine Learning|ml
COMP30023|Computer Systems|os
SWEN20003|Object Oriented Software Development|oop
MAST20004|Probability|stats2
MAST20005|Statistics|stats2
MAST20009|Vector Calculus|calc3
ECON20001|Intermediate Macroeconomics|macro2
ECON20002|Intermediate Microeconomics|micro2
ECOM20001|Econometrics 1|econometrics
FNCE20005|Corporate Financial Decision Making|corpfin""",
 "UQ": """CSSE2310|Computer Systems Principles and Programming|sys
COMP3702|Artificial Intelligence|ai
INFS2200|Relational Database Systems|db
ECON2010|Intermediate Microeconomics|micro2
ECON2020|Intermediate Macroeconomics|macro2
ECON2300|Introductory Econometrics|econometrics""",
 "ANU": """COMP2300|Computer Organisation and Program Execution|sys
COMP2310|Systems, Networks and Concurrency|
COMP3600|Algorithms|algo
COMP3620|Artificial Intelligence|ai
COMP3670|Introduction to Machine Learning|ml
ECON2101|Microeconomics 2|micro2
ECON2102|Macroeconomics 2|macro2
EMET2007|Econometrics I|econometrics
STAT2001|Introductory Mathematical Statistics|stats2""",
 "QUT": """CAB203|Discrete Structures|discrete
CAB301|Algorithms and Complexity|algo
CAB302|Software Development|se
CAB320|Artificial Intelligence|ai""",
 "UWA": """CITS2002|Systems Programming|sys
CITS2005|Object Oriented Programming|oop
CITS3001|Algorithms, Agents and Artificial Intelligence|ai
CITS3002|Computer Networks|net""",
}
def q(s): return "'" + s.replace("'", "''") + "'"
rows = []
def add(uni, block, prefix_rule):
    for line in block.strip().splitlines():
        code, title, g1 = line.split("|")
        g1 = g1 or None
        g2 = G2.get(g1) if g1 else None
        if not g2 and prefix_rule:
            g2 = PREFIX.get("".join(ch for ch in code if ch.isalpha())[:4])
        rows.append(f"  ({q(uni)}, {q(code)}, {q(title)}, {q(g1) if g1 else 'null'}, {q(g2) if g2 else 'null'})")
add("UNSW", UNSW, True)
for u, b in OTHER.items(): add(u, b, False)

sql = [open("migration_08_head.sql").read(),
 "insert into public.courses (uni_id, code, title, similar_group, similar_group_2, source) select v.uni_id, v.code, v.title, v.g1, v.g2, 'seed' from (values",
 ",\n".join(rows),
 ") as v(uni_id, code, title, g1, g2)",
 "on conflict (uni_id, code) do update set",
 "  title = case when public.courses.title = '' or public.courses.source = 'seed' then excluded.title else public.courses.title end,",
 "  similar_group = coalesce(excluded.similar_group, public.courses.similar_group),",
 "  similar_group_2 = coalesce(excluded.similar_group_2, public.courses.similar_group_2);",
 "",
 "-- Broad discipline for existing courses that only had a specific topic",
 "update public.courses set similar_group_2 = case similar_group " + " ".join(f"when {q(k)} then {q(v)}" for k, v in G2.items()) + " end",
 "where similar_group_2 is null and similar_group is not null;",
 "",
 "-- UNSW courses added by students or transcripts: discipline from the code prefix",
 "update public.courses set similar_group_2 = case left(code, 4) " + " ".join(f"when {q(k)} then {q(v)}" for k, v in PREFIX.items()) + " end",
 "where uni_id = 'UNSW' and similar_group_2 is null;",
]
open("migration_08_more_courses.sql", "w").write("\n".join(sql) + "\n")
print(len(rows), "courses")

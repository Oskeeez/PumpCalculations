/** EPANET example network Net1 (US units, Hazen-Williams), as a steady snapshot. Public example from the EPANET distribution. */
export const NET1_INP = `[TITLE]
 EPANET Example Network 1

[JUNCTIONS]
;ID  Elev  Demand  Pattern
 10  710   0   ;
 11  710   150  1 ;
 12  700   150  1 ;
 13  695   100  1 ;
 21  700   150  1 ;
 22  695   200  1 ;
 23  690   150  1 ;
 31  700   100  1 ;
 32  710   100  1 ;

[RESERVOIRS]
 9  800

[TANKS]
 2  850  120  100  150  50.5  0

[PIPES]
 10   10  11  10530  18  100  0  Open
 11   11  12  5280   14  100  0  Open
 12   12  13  5280   10  100  0  Open
 21   21  22  5280   10  100  0  Open
 22   22  23  5280   12  100  0  Open
 31   31  32  5280   6   100  0  Open
 110  2   12  200    18  100  0  Open
 111  11  21  5280   10  100  0  Open
 112  12  22  5280   12  100  0  Open
 113  13  23  5280   8   100  0  Open
 121  21  31  5280   8   100  0  Open
 122  22  32  5280   6   100  0  Open

[PUMPS]
 9  9  10  HEAD 1

[PATTERNS]
 1  1.0  1.2  1.4  1.6  1.4  1.2

[CURVES]
 1  1500  250

[CONTROLS]
 LINK 9 OPEN IF NODE 2 BELOW 110

[QUALITY]
 10 0.5

[TIMES]
 Duration 0

[OPTIONS]
 Units GPM
 Headloss H-W
 Specific Gravity 1.0
 Viscosity 1.0
 Trials 200
 Accuracy 0.00001

[COORDINATES]
 10  20  70
 11  30  70
 12  50  70
 13  70  70
 21  30  40
 22  50  40
 23  70  40
 31  30  10
 32  50  10
 9   10  70
 2   50  90

[END]
`;

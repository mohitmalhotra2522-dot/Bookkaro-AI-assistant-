/**
 * Station catalog (reference data) — official station code → station name, for resolving a station the user / LLM
 * named ("Svdk", "Shri Mata Vaishno Devi Katra"). Generated from the RailRadar station lookup (/v1/lookup/stations,
 * 12789 codes, fetched 2026-10-09; cabin pseudo-codes "XX-…" dropped). Static reference only: never availability,
 * fares or timings; the selected provider still validates every code it is asked about.
 * Format: one "CODE<TAB>Name" per line.
 */
export const STATION_CATALOG_SOURCE = 'railradar:/v1/lookup/stations@2026-10-09';
export const STATION_CATALOG_TSV = `AA	Ataria
AABH	Ambika Bhawani Halt
AADR	Amb Andaura
AAFN	M/S. Akhilesha Agro Farms Private Limited.
AAG	Angar
AAGH	Antagarh
AAGJ	Adani Agri Logistics (Darbhanga) Limited GCT
AAGK	Adani Agri Logistics (Samastipur) Ltd. GCT
AAGM	M/S ACC Limited, Ametha GCT Served By Mehgaon
AAGN	M/S Adani Agri Logistics (Panipat) Ltd.
AAH	Itehar
AAK	Ankaikila
AAL	Amlai
AALJ	Adani Agri Logistics (Kannauj) Limited GCT Jasoda
AAM	Angadippuram
AAP	Ambiapur
AAR	Adesar
AAS	Asranada
AASM	Albion SDG No.1, Mahuda
AAU	Alapadu
AAV	Ambav
AAY	Aralvaymoli
AB	Ambur
ABB	Abada
ABBS	Burragarh Siding of M/S. BCCL
ABD	Ambli Road
ABE	Ambikeshwar
ABEC	Ahmedabad Electric Shed
ABFC	Ambari Falakata
ABGM	Ambalgram
ABGT	Arabagatta Halt
ABH	Ambarnath
ABHR	Bejdih Sdg. of M/S. ECL
ABI	Ambaturai
ABJK	Bokaro Jharia 2 (Bj-I) of M/S. BCCL
ABKA	Ambika Kalna
ABKD	Bhowrah No. 5, Khanudih
ABKH	Bhowrah No. 6, Khanudih
ABKM	Adambakkam
ABKP	Ambikapur
ABLE	Ambale
ABLS	ACC Bab Cock Durgapur
ABO	Asthal Bohar
ABP	Akbarpur
ABPK	Bhowrah Bye Products and Coke Oven No.16, Khanudih
ABR	Abu Road
ABRV	Ambari Richhavi
ABS	Abohar
ABSA	Ambasa
ABSB	Ballihari No.11, Bagha
ABSD	223abod Military Siding
ABSG	Ordnance Factory SDG Abh
ABSK	Bhowrah No. 4 of M/S. BCCL
ABT	Ambagarattur
ABU	Ambattur
ABW	Abutara
ABX	Ambari
ABY	Ambivli
ABZ	Adgaon Buzurg
ACAB	Bondamunda A Cabin
ACBD	A Cabin/Bmy
ACCG	ACC Siding
ACCI	Adichunchanagiri Halt
ACCJ	ACC Ltd. Sdg, Jhinkpani
ACD	IOC Siding (P) (MG)
ACDA	Ajni Depot
ACG	Achegaon
ACH	Achalganj
ACK	Acharapakkam
ACL	Ancheli
ACLA	Amlai Colliery Siding
ACLE	Azimganj City
ACLN	New Ancheli
ACLR	M/S Ambuja Cement Ltd
ACN	Adhichchanur
ACND	A N Dev Nagar
ACOI	Allahabad Chheoki Jn
ACPC	M/S. Arjas Steel Private Limited SDG Served By Clpe Rly Stn Gtl
ACPR	Archipathar
ACRN	Achirne
ACS	Ultratech Cement Siding-Shambhupura & Chittorgarh
ACSG	DCOS Sdg, Dahod
ACSK	Angarpathra Collery Sdg, Katrasgarh
ACSR	Chinakuri No.15 (for Pits 1 &2), Radhanagar
ACSY	M/S. Ambuja Cements Ltd.
ACTR	Anaanta Colliery Siding
ACU	Achuara Halt
AD	Adoni
ADAW	Adra Workshop
ADB	Adilabad
ADD	Adas Road
ADE	Adari Road
ADF	Adina
ADH	Andheri
ADHL	Adihalli
ADHT	Ashokdham
ADI	Ahmedabad Jn
ADIJ	Ahmedabad Jn MG
ADIP	Duncon Industies Ltd. , Panki
ADL	Andul
ADMS	Ammunition Depot Military Siding Dhappar
ADP	Ahmadpur Jn NG
ADPT	Andipatti
ADQ	Adhikari
ADR	Mandi Adampur
ADRA	Adra
ADRE	Adra East Cabin
ADRL	Adderley
ADSL	Ammunition Depot Military Siding, Lalru
ADSR	Advance Starter
ADST	Adi Saptagram
ADT	Aduturai
ADTL	Adhartal
ADTP	Adityapur
ADVI	Adavali
ADX	Adapur
AE	Amreli
AECS	Electric Power House Siding - Sabarmati
AED	Aulenda
AEE	Alachor
AEH	Anant Paith
AEJ	Arnej
AEK	Anekal Road
AEL	Ateli
AELN	New Ateli Jn
AEMD	M/S. Adani Electricity Mumbai Ltd.-Dahanu Road
AEP	Amreli Para
AERH	Agrer Halt
AEX	Adderi
AF	Agra Fort
AFAS	M/S Adani Forwarding Agent Ltd - Sanjan Gati Shakti Multi Modal
AFCS	FCI Sdg, Angamali For Kaladi
AFK	Angamali
AFR	Asafpur
AFSD	Air Force Siding Digaru (BG)
AFSN	Almohri Wharfwall NCL Siding
AG	Aranghata
AGA	Agra City
AGAE	Agradwip
AGAS	Agas
AGB	Ambagaon
AGC	Agra Cantt Jn
AGCI	Angadi
AGD	Agasod
AGDL	Agran Dhulgaon
AGE	Angai
AGI	Amguri
AGL	Amargol
AGM	Agaram Sibbandi
AGMN	Agomoni
AGN	Amgaon
AGP	Agarpara
AGQ	Asirgarh Road
AGR	Amargarh
AGS	Alwar Goods Shed
AGSA	Ajni Goods Shed Served By Ajni
AGSN	Agasan
AGT	Agthori
AGTL	Agartala
AGTR	Agthori
AGV	Angua
AGX	Agastiyampalli
AGY	Agori Khas
AGZ	Amagura
AH	Achhnera Jn
AHA	Abhaipur
AHD	Aherwadi
AHH	Ahmadgarh
AHI	Ashti
AHJU	Ahju
AHL	Ajharail
AHLR	Ahalyapur
AHM	Ahimanpur
AHMP	Adarsh Manpur
AHN	Ahiran
AHO	Adarshnagar
AHQ	Ahera Halt
AHT	Amghata
AHU	Ahirauli
AHZ	Adhinpur
AI	Adipur
AIA	Ajaraka
AIAP	Amari Adalpur
AIG	Algawan
AIH	Alawalpur I Pur
AII	Ajmer Jn
AIIW	Ajmer Workshops
AILM	Ailam
AIP	Attippattu
AIPC	India Cements Ltd Siding
AIPH	Hindusthan Petroleum Corporation Limited Private Siding
AIPO	Ennore Coal Terminal Private Limited Siding
AIPP	Attipattu Pudu Nagar. H
AIPS	Thermal Power Plant Siding, Attipattu
AIPZ	Zuari Cements Ltd Siding
AIR	Alindra Road
AIRL	Airoli
AIS	Ajmer Store Siding
AIT	Ait
AJ	Ajgain
AJBB	Jardian Balihery -2 (Jb-2) (south), Bhaga
AJE	Anjar
AJH	Ajhai
AJI	Anjhi Shahabad
AJIT	Ajit
AJJ	Arakkonam Jn
AJJB	Ramco Industries Ltd
AJJN	Arakkonam North Jn
AJK	Ajakollu
AJKI	Ajitkheri
AJL	Ajitwal
AJLE	Azimganj Jn Cabin
AJLS	Arakkonam Electric Loco Shed
AJM	Adraj Moti
AJMB	Adrajmoti
AJMK	Bokaro Jharia Main Line, Khanudih
AJN	Ajnod
AJNI	Ajni
AJP	Ajjampur
AJR	Ajaibpur
AJRE	Aujari
AJTM	Ajitgill Matta
AJU	Arjuni
AJUG	Abjuganj
AJWA	Ajwa
AJWS	Jorapukur Washery, Sudamdih
AK	Akola Jn
AKAH	Artalakatta
AKAT	Akkampet
AKB	Akola B Cabin
AKD	Akodia
AKE	Akanapet
AKFS	Transformers and Electricals Kerala Ltd, Afk
AKI	Adarki
AKIP	Akaipur Halt
AKIS	Kseb Idikki Hydro Electric Sdg, Afk
AKJ	Akbarganj
AKK	Akkihebbaiu
AKKK	Kustor Siding of M/S. BCCL
AKL	Anakhol
AKLA	Aklera
AKM	Arambakkam
AKN	Akbarnagar
AKNB	Kankanee Siding of M/S. BCCL
AKNR	Adhyatmik Nagar
AKOR	Akalkot Road
AKOT	Akot
AKP	Anakapalle
AKPK	M/S Adani Krishnapatnam Port Ltd. Siding, Krishnapatnam
AKR	Akolner
AKRA	Akra
AKRD	Akurdi
AKS	Ankuspur
AKSP	Anksapur
AKT	Akaltara
AKTS	Amarkantak Thermal Pwr Stn
AKU	Angalakuduru
AKV	Ankleshwar Jn
AKVD	Akividu
AKVU	Ankleshwar Udyognagar.
AKW	Akona
AKWS	Kargali Washery,bermo
AKY	Akkurti
AKZ	Akashi
AL	Attili
ALAI	Alai
ALAL	Alal
ALAT	Avuladatla
ALAU	Alau
ALB	Alia Bada
ALBK	Layabad No.20, Khanudih
ALCK	Layabad Electric Supply Coke Co. No.28, Khanudih
ALD	Allahabad
ALE	Amletha
ALER	Aler
ALEU	Alembic Chemical Works Sdg, Vadodra Jn
ALGP	Algapur
ALGU	Allugundu
ALGV	GCT Multi-Model Cargo Terminal of M/S Adani Logi Ltd.-Virochannagar
ALIK	Adani Logistic Ltd ICD
ALJ	Aliganj
ALJN	Aligarh Jn
ALK	Alakkudi
ALL	Alal
ALLP	Alappuzha
ALM	Alamanda
ALMG	Alamganj
ALMR	Alampur
ALMW	Almaw
ALN	Alandi
ALNI	Alniya
ALNP	Akelahanspur (Halt)
ALP	Alapakkam
ALPD	Adalpahari
ALPR	Alampur Road
ALS	Amlori Sarsar
ALU	Ariyalur
ALUH	Alauli
ALUM	The Ramco Cements Ltd SDG/Alu
ALUR	Alur
ALUS	Ariyalur Cement Siding
ALV	Anklav
ALW	Alwal
ALY	Allahabad City
AMA	Atamanda
AMB	Ambodala
AMBG	Arambag
AMBH	Aghwanpur Block Hut
AMBK	Mohalboni SDG No.11,khanudih
AMBR	Ambika Rohina
AMC	Amritapura
AMD	Amila
AMDI	Amdi P. H.
AME	Amethi
AMG	Alamnagar
AMGA	Amjonga
AMGU	Ammuguda
AMH	Azamgarh
AMHA	Ametha
AMI	Amravati
AMIC	Amravati Coach Washing Yard
AMIN	Amin
AMJ	Amingaon
AML	Amalsad
AMLA	Amla Jn
AMLG	Ahluwalia Mining Pvt Ltd Siding Satna
AMLI	Amli
AMLO	Amlo
AMLP	Amalpur
AMLR	Amala Nagar
AMLS	GCT Multi-Modal Cg Tml of M/S Arya Multilogistics Pvt Ltd-Surbari
AMLX	Amla Jn Yard
AMM	Adirampatinam
AMNE	Amalner Bhandyache
AMNR	Ammanur
AMNWN	Amanwan
AMO	Amolwa
AMOD	Amod
AMP	Ahamadpur Jn
AMPA	Ambalappuzha
AMPL	Ammapalli Halt
AMPR	Amarpura Rathan
AMPS	M/S. Adani Track Management Services Private Ltd./Sjq
AMQ	Ammuguda
AMQX	Ammuguda Chord Line
AMRA	Amha Pipra
AMRD	Methani Siding, of M/S. ECL
AMRI	Anaj Mandi
AMRO	Amroha
AMS	Amausi
AMSA	Ammasandra
AMSC	Mysore Cements Siding S/B Amsa
AMSG	Air Force Siding, Amla
AMSK	Mohalboni SDG No.9,khanudih
AMT	Ammapet
AMTA	Amta
AMV	Lucknow Alambagh
AMVA	Amaravila Halt
AMW	Aman Vadi
AMWM	Murulidih Washery,mahuda
AMX	Amlakhurd
AMY	Akathumuri
AMZ	Amta
AN	Amalner
ANA	Aslana
ANAH	Aunta Halt
ANAS	Anas
ANB	Ammanabrolu
ANC	Annechakanahali
ANCR	Anchuri
AND	Andampaliam
ANDB	Ammunition Depot
ANDI	Adarsh Nagar Delhi
ANDM	North Damodar Main, Mahuda
ANDN	Anand Nagar
ANE	Anantarajupet
ANF	Anandapuram
ANG	Ahilyanagar
ANGL	Angul
ANGM	Aungridhan
ANGR	Angadgeri Halt
ANH	Ankorah Akorha
ANI	Ajanti
ANJ	Anjangaon
ANJE	Angarpathra Halt
ANK	Ankai
ANKI	Anakhi
ANKL	Ankola
ANKX	Ankai Manmad Direct
ANL	Antroli
ANLG	Aman Lodge
ANM	Anaimalai Road
ANMD	Arang Mahanadi
ANMP	Arjun Nagar Halt
ANND	Anand Jn
ANNG	Annanagar
ANNR	Annanur
ANO	Anjani
ANP	Anandatandavapuram
ANPD	Anpara Road
ANPM	Anupalem
ANPR	Anpara
ANQ	Amnapur
ANR	Anara
ANSB	Anandpur Sahib
ANSM	Nowagan No.1,mohuda
ANT	Anantnag
ANTU	Antu
ANU	Anangur
ANV	Annavaram
ANVR	Anand Vihar
ANVT	Anand Vihar Terminal
ANW	Anawal
ANY	Arumuganeri
AO	Aonla
AOCD	Aoc Siding (P) (MG)
AOMM	M/S. Aarya Ocean Logistics Park Pvt. Ltd. Served By Maliya Miyana
AON	Araon
AONI	Amoni
AOR	Argora
AP	Ashokapuram
APA	Amarpura
APAP	Agri-Park
APB	Anuppambattu
APCH	Alipurduar College
APCN	M/S. Challa Srinivas Reddy & Others
APD	Alipur Duar
APDC	Alipur Duar Crt
APDJ	Alipur Duar Jn
APE	Andanappettai
APG	Anupganj
APH	Anupgarh
API	Akkaraippatti
APJ	Amarpur Jorasi
APJG	GCT of M/S Adani Power Limited
APK	Aruppukkottai
APKB	Pure Burragarh Kanga No.1, Bhaga
APKH	Asanpur Kupha Halt
APL	Appikatla
APLP	Pol Siding Partapur
APLS	Adani Power Rajasthan Limited Siding
APLU	Adani Power Limited Udupi Served By Nandikoor
APMR	Appaipally
APN	Ayodhyapattanam
APNM	North Damodar No.3, Mahuda
APP	Ambapendarpur Halt
APQ	Aditpara
APR	Anuppur Jn
APRD	Ashapurna Devi
APRH	Alehpur Halt
APRK	Parbelia Spur, Ramkanali
APSA	M/S. Adani Ports & Special Economic Zone Ltd.(apsez) Port Terminal
APSN	Angus Pvt. Sdg. No.2 Bhadreshwar Ghat
APT	Anaparti
APTA	Apta
APU	Anipur
APWP	Ap State Warehousing Investors Godown
AQ	Ajni Electric Loco Shed
AQG	Ashapura Gomat
AQX	Ajni Yard
ARA	Ara
ARAG	Arag
ARCL	Arunachal
ARD	Amarda Road
ARE	Arnetha
ARG	Angar Ghat
ARGD	Arigada
ARGL	Argul PH
ARGP	Aralaguppe
ARH	Amhera
ARI	Antri
ARIK	Arshiyarailinfrastructurelimited (Aril) ICD Siding
ARIS	M/S,amtek Rail Car Industries Pvt. Ltd.
ARJ	Aunrihar Jn
ARK	Araku
ARKA	Arkha
ARKV	Araku Valley
ARL	Araul Makanpur
ARMD	Arf Military Siding/Daulatabad
ARMU	Armur
ARN	Arand
ARNA	Arniya
ARNB	Amarun
ARNG	Arun Nagar P. H.
ARNH	Arjunahalli
AROR	Aroor Halt
ARP	Atrampur
ARPI	Adurupalli
ARPL	Arepalli Halt
ARPR	Alirajpur
ARQ	Arariya Court Jn
ARR	Arariya Jn
ARS	Arasur
ARSG	Central Ordinence Depot Militry Siding Agra
ARSR	Radhanagar Siding, Radhanagar
ARU	Arasalu
ARV	Arni Road
ARVI	Arvi
ARVY	M/S. Arv Cements Society and ACC Limited
ARW	Ahraura Road
ARWN	New Ahraura Road Jn
ARX	Areli
AS	Arjansar
ASAB	Asst. Siding Amlabad No.2 Served By Bhojudih
ASAF	Asifabad Road
ASAN	Asan
ASAR	Asara Halt
ASB	Asanboni
ASBB	Burragarh No.1, Bhaga
ASBK	Asstt. Sdg. Bokaro Jahria No.6. Khanudih.
ASBS	Asb Sultan (Warisganj)
ASCE	Athsarai
ASCR	Chinakuri No. 3 of M/S. ECL
ASD	Ambasamudram
ASE	Asaudah
ASFC	Hindustan Fertilizer .corpn. Ltd Durgapur
ASGN	GCT of M/S Aarti Steels Limited
ASGS	Gati Shakti Cargo Terminal (Gsct) of Actl Samba Private Ltd.
ASH	Aishbagh
ASI	Arseni
ASJP	Amar Saheed Jagdeo Prasad Halt
ASK	Arsikere Jn
ASKB	Kankanee No.1, Bhojudih
ASKN	Ashok Nagar
ASKR	Ashok Nagar Road
ASL	Aslaoda
ASLS	Andhra Sugars Ltd
ASLU	Aslu
ASM	Asarma
ASMA	Amristar Sugar Mill Siding
ASN	Asansol Jn
ASNE	Asansol East Cabin
ASNM	Nowagan No.3, Mohuda
ASNR	Sodepur No.3a, Radhanagar
ASO	Asangaon
ASP	Aspari
ASPR	Parbelia Siding of M/S. ECL
ASR	Amritsar
ASRN	Sodepur No.9 & 10 Pits, Radhanagar
ASSH	Aishbagh
ASSR	Swetalpur No.10, Radhanagar
AST	Asaoti
ASTG	Astegaon
ASTL	Assit Sdg. of M/S Texmaco Ltd Balgharia
ASV	Asarva Jn
ASWC	Apswc Siding Owned By Sri Nanda Kumar & Others
AT	Asnoti
ATA	Ata
ATB	Alattambadi
ATC	Arts College
ATDA	Atladara
ATE	Atarra
ATG	Atgaon
ATGC	M/S Emirates Terminal Pvt Ltd GCT (Etgc) Served By Chandisar
ATH	Antah
ATKS	Atwa Kursath
ATL	Athmal Gola
ATLP	Tata Steel Bsl Ltd Siding
ATM	Altagram
ATMB	Atomic Power Project Siding, Tarapur-Boisar
ATMO	Aithal
ATNR	Awatarnagar
ATP	Anantapur
ATPA	Awantipura
ATPS	Anpara Thermal Power SDG
ATQ	Arantangi
ATR	Attar
ATRI	Atri PH
ATRR	Atraura
ATRU	Atru
ATS	Attabira
ATT	Atari
ATU	Attur
ATUL	Atul
ATUV	M/S Atul Siding
ATW	Atwa Muthia Halt
ATWN	Asthawan
ATX	Alinagar Tola
AUB	Aluabari Road
AUBR	Anugraha N Road
AUI	Aurahi
AUL	Agsauli
AULS	Ankur Udyog Limited (steel Division) GCT Sahjanwa
AUN	Aurang Nagar
AUNG	Aung
AUR	Atrauli Road
AUS	Anupshahr
AUWA	Auwa
AV	Asvali
AVA	Ambewadi
AVC	Amaravathi Colony Jn
AVCD	Avoiding Cabin
AVD	Avadi
AVDT	Tube Products of India Siding
AVH	Avidha
AVK	Aravankadu
AVL	Amritvel
AVLI	Aravalli
AVN	Anavardikhanpettai
AVP	Abhanpur Jn
AVRD	Aravali Road
AVS	Auvaneswsarem
AVT	Avatihalli H
AWB	Aurangabad
AWBB	Angus Engg. Works SDG of Braithwaite (1) Ltd. Bhadreshwar Ghat
AWCA	M/S. Anaparti Warehousing Complex Pvt Ltd.,served By Anaparti
AWG	Awa Garh
AWH	Alewahi
AWL	Alawalpur
AWM	Aswapuram
AWP	Aghwanpur
AWPR	Awapur
AWR	Alwar Jn
AWS	Awasani Halt
AWT	Alwar Tirunagri
AWY	Aluva
AWZ	Ahiwara
AXA	Amarsar
AXK	Asokhar
AXR	Alluru Road
AY	Ayodhya Dham Jn
AYB	Aliyabad
AYC	Ayodhya Cantt
AYD	Ayandur
AYI	Ayingudi
AYM	Adiyakkamungalm
AYN	Aiyanapuram
AYR	Ayyalur
AYRN	Akshaywat Rai Nagar
AYS	Adharsatra
AYU	Abhayapuri Asam
AYV	Aryankavu
AYVN	Aryankavu New Block
AZ	Azimganj Jn
AZA	Azara
AZK	Azhwarkurichi
AZP	Ayyampet
AZR	Azamnagar Road
BA	Bandra
BAA	Barala
BAAR	Bandar PH
BAB	Babina
BABH	Behlba
BABR	Balanagar
BAC	Bargachia
BAD	Bad
BADA	Bardha Halt
BADH	Badhauna Halt
BADK	Barka
BADR	Bhader
BAE	Baliakheri
BAF	Bap
BAGA	Bhagega
BAGD	Bagwada
BAGJ	Barharaganj
BAGL	Bara Gopal
BAGMA	Bagma
BAGN	New Bhagega Crossing Station
BAH	Bhabhar
BAHI	Balenahalli
BAHL	Banihal
BAHN	Babhan Gaon Halt
BAHP	Band Hamirpur
BAHW	Bahir Khanda
BAI	Bassi
BAIS	Barpeta Agro Infra Siding ( Pvt/Bg), Sorbhog
BAJ	Bhalej
BAJE	Bajakare Halt
BAJN	Bajanabajana
BAK	Bhankari
BAKA	Banka
BAKK	Bakkal
BAKL	Bakal
BAKT	Barhara Kothi
BAL	Budalur
BALE	Bale
BALI	Bhaili
BALR	Baitalpur
BALT	Baltikuri Jn
BALU	Balugan
BAM	Brahmapur
BAMA	Birambad
BAMR	Bamur
BAMY	Bandra Marshalling Yard
BAND	Banaswadi
BANE	Basni
BANI	Bani
BANL	Bhatangli
BANO	Bano
BANR	Bhaner
BAO	Banmor
BAOL	Baoli
BAP	Belapur
BAPN	Bairpur Halt
BAPR	Ballupur
BAQ	Ganj Basoda
BAR	Bar
BARA	Bara
BARD	Duvri Kalan
BARH	Barh
BARI	Bari
BARJ	Bharatgarh
BARL	Baral
BARN	Baranagar Road
BARS	Barsana
BARU	Baharu
BASA	Banosa
BASN	Bhainswan
BASR	Batesar
BAST	Bassra Colly. SDG
BAT	Batala Jn
BATA	Bantva
BATL	Baihatola
BATM	Batala Sugar Ml
BATS	Bhatsar
BATY	Block Cabin 'a' of Tomka 'y' Connection
BAU	Burhanpur
BAV	Baruva
BAW	Chik Banavar
BAWA	Balwara
BAWD	Bhadwad
BAY	Ballari Jn
BAYD	Bayad
BAYP	Ballari Bypass Cabin
BAZ	Baran
BBA	Babrala
BBAE	Baidyabati
BBAI	Bhadbhunja
BBAR	Bara
BBC	Bhachhbar
BBCE	Bulbulchandi
BBD	Bablad
BBDA	Barbenda Jn
BBDB	Benoy Badal Dinesh Bag
BBDE	Babarpur
BBE	Baghi Bardiha
BBGN	Barua Bamungaon
BBHL	Bela Bela
BBHT	Barabar Halt
BBI	Bara Bani
BBJ	Babaganj
BBJM	Budge Budge Jute Mills , Budge Budge
BBK	Barabanki Jn
BBKR	Baba Bakalaraya
BBL	Balrai
BBLA	Bhyabla Halt
BBLK	B L Daspuri
BBLS	Baradwar Ballast Siding
BBM	Barabhum
BBMN	Bari Brahman
BBMT	Balaram Siding of M/S MCL
BBN	Barbil
BBNB	Bogibeel Bridge North Block Hut
BBNH	Bedra Bommanahalli
BBO	Babugarh
BBPM	Balabhadrapuram
BBPR	Babupur
BBQ	Basin Bridge Jn
BBR	Bagh Bazar
BBRD	Bhuban Road
BBRI	Banshbari Halt
BBRM	Baba Bhagwan Ram Halt
BBS	Bhubaneswar
BBSB	Bijuri Ballast Siding
BBSD	Birla Super Siding
BBSK	Bunkar Sdg, Hsl Bolani Khadam
BBSL	Baba Sodhal Nagar
BBSN	Bhubaneswar New Jn
BBT	Birati
BBTR	Barbatpur
BBTY	Block Cabin B
BBU	Bhabua Road
BBV	Babhulgaon
BBW	Bodarwar
BBY	Bhadroli
BC	Bareilly City
BCA	Bachwara Jn
BCB	Bhowra Bh
BCBM	Balumath CCL Siding
BCCB	Bilaspur Chord Cabin
BCCK	Bulk Cement Corp Siding Klmi
BCD	Bansdih Road
BCDL	Bankola No.1 Colliery Siding
BCF	Bankapasi
BCFG	Grasim Industries Limited
BCGM	Bainchigram
BCH	Berchha
BCHL	Bacheli
BCHN	Bochasan Jn
BCHR	Bachar
BCHT	Barh Court Halt
BCJ	Bagahabishunpur
BCK	Balichak
BCL	Mumbai Central
BCMB	Balrampur Chini Mil SDG (MG)
BCME	Burnco Siding
BCMR	Bechimari
BCMT	Bharatpur Pvt Siding of MCL
BCN	Bachhrawan
BCNW	Burn & Co. No 3 West SDG Barakar
BCOB	Bhachau BG
BCP	Bichpuri
BCPG	BALCO Captive Power Plant Siding
BCPL	Brahmaputra Cracker&polymer Ltd.(p) Siding
BCPR	Bachharpur Halt
BCQ	Barachak Jn
BCRB	Bijuri Collery Siding
BCRD	Barchhi Road
BCRY	Bachra Colliery Siding (Old)
BCSA	Bankola No.2 Colliery Sdg.
BCSB	Burhar Colliery
BCSK	Bina Pvt Siding
BCSL	Bondamunda Central Sick Line
BCSP	Bhurkunda Siding
BCSR	Bachra Siding At Ray (bachra New)
BCSW	Birla Corpn Ltd Satna Cement Works Siding
BCT	Mumbai Central
BCTL	Bhanora Rly SDG
BCU	Bhuchchu
BCW	Bhawi
BCY	Varanasi City
BCYN	Budhdevchak Yadav Nagar
BD	Badnera Jn
BDA	Vadodara C Cabin
BDAG	Bonidanga
BDB	Vrindavan
BDBA	Badabandha
BDBG	Badhai Balamgrh
BDBP	Basudebpur
BDBR	Bhogdabar Halt
BDBS	Bindubasini Halt
BDC	Bandel
BDCR	Bhadrachalam Road
BDDR	Badodar
BDE	Bodeli
BDGM	Badgam
BDGN	Bhandegaon
BDGP	Badanaguppe
BDGU	Budagumpa
BDH	Bhedia
BDHA	Badhada
BDHG	Budhgahaon
BDHL	Badhal
BDHN	Bodhan
BDHP	Bhudpur
BDHT	Bardi Halt
BDHY	Budhi
BDI	Bhadli
BDIH	Bandhdih
BDIN	Bhadaiyan
BDJ	Vadakara
BDJR	Bhadora Jagir
BDK	Bedag
BDKA	Bhairidevarakoppa
BDKD	Bhandarkund
BDKE	Bhadsivni
BDKN	Bandhua Kalan
BDKT	Badakhandita
BDL	Vindhyachal
BDLC	Bonidanga Link Cabin
BDLN	Bordolani
BDLS	Badnera Old Steam Loco Shed
BDM	Badami
BDMA	Budhma
BDME	Baidyanathdham
BDMJ	Bhodwal Majri
BDN	Bhadan
BDNH	Bhudevi Nagar
BDNK	Bodinayakkanur
BDNN	New Bhadan
BDNP	Bidanpur
BDO	Bahalda Road
BDPA	Badalpur PH
BDPG	Bada Padagaon
BDPK	Burhapanka
BDPL	Bandarupalle
BDPR	Brindabanpur
BDQ	Budora
BDRD	Bhadravadi
BDRI	Bhadrauli
BDRL	Byadarahalli
BDRN	Bhadran
BDRW	Badnera Wagon Repair Workshop
BDS	Baradighi
BDSR	Bhadreshwar Raod
BDSW	Budhsinghwala
BDT	Bordubi Road
BDTH	Badhet Halt
BDTS	Bandra Terminus
BDU	Badnapur
BDUA	Basudeopur Chandel H
BDV	Badanahalu
BDVL	Budvel
BDVR	Boddavara
BDVS	Mysore Paper Mills Ltd
BDVT	Bhadravati
BDW	Bandanwara
BDWA	Badhwa Bara
BDWD	Bodwad
BDWL	Biradhwal
BDWS	Badarwas
BDXT	Basai Dhankot
BDXX	Badearapur
BDY	Buddireddippati
BDYD	Bhilai Departure Yard
BDYK	Bindayaka
BDYP	Bidyadharpur
BDYR	Bidyadabri
BDYX	Badnera Jn Yard
BDZ	Badkulla
BE	Bareilly (NR)
BEA	Bihiya
BEAS	Beas
BEB	Beldanga
BEC	Berach Jn Cabin
BECK	B. E.a. Colly. SDG
BECN	Bikaner East
BED	Baseri
BEDM	Bedham
BEE	Bebejia
BEED	Beed
BEF	Bhupdeopur
BEG	Behtagokul
BEGS	Barkakana Extention Goods Shed
BEH	Bagdihi
BEHI	Bennehalli
BEHJ	Behaj
BEHR	Beohari
BEHS	Bihar Sharif
BEHT	Bihat Halt
BEI	Shivamogga Bidare (Shimoga)
BEJ	Beniganj
BEK	Bundki
BELA	Bela
BELD	Belkhera
BELT	Bela
BEM	Badaun
BEML	Beml Nagar
BEMR	M/S. Bhatia Energy & Minerals Pvt. Ltd. /Rob
BENA	Belonia
BENL	Benl
BEO	Birohe
BEP	Bheerpur
BEPR	Belapur Cbd
BEQ	Belur
BER	Beawar
BERO	Bero
BES	Bes
BESB	M/S Bhartia Elec. Steel Co. (Besco) Brp
BESC	M/S Bhartia Electric Still Co. Bln
BESG	Maharashtra State Electricity Board Siding Paras
BESY	Belur Scrap Yard
BET	Bareth
BETA	Barethiya
BETI	Bhetasi
BEU	Bisheshwarganj
BEW	Betavad
BEX	Belboni
BEY	Bugganipalle
BF	Bagetar
BFD	Borhat
BFE	Bahawal Basi
BFF	Barabhati
BFG	Bagthar
BFJ	Bhoras Budrukh
BFM	Bhalui
BFN	Bugana
BFP	Bilochpura
BFPA	Bhopatpur
BFQ	Bendi
BFR	Bekal Fort
BFS	Bharawas
BFSG	Bharat Forge Comp Sdg.
BFT	Bhabta
BFTL	Boiler Factory of M/S Texmaco Ltd. Blh
BFV	Bahelia Buzurg
BFW	Byatrayanhalli
BFX	Baghi Ghauspur
BFY	Bhesana
BFZ	Bhandartikuri
BG	Bhongir
BGA	Bagalia
BGAE	Balagarh
BGAN	Bangain
BGAR	Bangari
BGB	Budge Budge
BGBG	Budge-Budge Goods
BGBI	Bagribari
BGBR	Bagbahra
BGCD	Bhadreshwar Ghat Coal Dump SDG Bhadreshwar Ghat
BGCK	Bhatgoan Colliery SDG (Chp)
BGD	Bara Gudah
BGDI	Bagadia PH
BGDS	Bhagwanpur Desu
BGF	Bagila
BGG	Banta Raghunathgarh
BGH	Baghauli
BGHI	Baghai Road
BGHT	Barka Gaon
BGHU	Borraguhallu
BGJT	Bagha Jatin
BGK	Bagalkot
BGKA	Bangurkela
BGKT	Bhagat ki Kothi
BGL	Bagula
BGLI	Bargolai
BGM	Belagavi
BGMA	Bagma
BGMN	New Bangurgram
BGMR	Bagumra
BGMU	Bangarmau
BGN	Borgaon
BGNA	Balgona
BGND	Boginadi
BGNP	Banaganapalle
BGNR	B. G.nagar
BGO	Bogri Road
BGP	Bhagalpur
BGPA	Bageshapura
BGPI	Bogapani
BGPL	Baghuapal
BGPR	Bhagwanpura
BGQ	Bhongaon
BGR	Bhagdara
BGRA	Baghnapara
BGRD	Beliaghata Road
BGRM	Biggabas Ramsara
BGRR	Bagarpur Halt
BGS	Begusarai
BGSF	Bisugirsharif
BGSN	Buffer Storage Godown Siding
BGTA	Bagra Tawa
BGTE	Bagahati
BGTN	Bhagtanwala
BGU	Bairagnia
BGUA	Baiguda
BGV	Balegundi
BGVN	Bhigwan
BGWD	Bagewadi H
BGWI	Begdewadi
BGWR	Baghwar
BGX	Bagri Sajjanpur
BGY	Bangriposi
BGZ	Bahadurgarh
BH	Bharuch Jn
BHA	Bhandai Jn
BHAD	Barhapur Halt
BHAE	Bhadreshwar Ghat
BHAK	Banhera Khas
BHAL	Bhatiel
BHAN	Bhoyani
BHAS	Bhojras
BHAT	Bhatpura
BHAU	Bhalua
BHAW	Blockhut A
BHB	Badla Ghat
BHBK	Bodhadi Bujrug
BHBR	Bathua Bazar Halt
BHBT	Basantar Block Hut
BHBV	Block Hut B (Bhb)
BHC	Bhadrakh
BHCH	Block Cabin Chakki Bank
BHCL	Bahora Chandil
BHD	Badli
BHDH	Bahadurpur H.
BHDR	Bhadri
BHEG	Bharat Heavy Electrical Siding-Khajraha
BHEH	BHEL Siding, Hardwar
BHEL	BHEL Halt
BHEN	New Bhestan
BHES	Bharath Heavy Electricals Siding
BHET	Bhestan
BHG	Bhaton ki Gali
BHGH	Bhairgachhi
BHGJ	Bihariganj
BHGN	Bhilgaon
BHGP	Bhagirathpur
BHHT	Barhara
BHHZ	Behta Hazipur Halt
BHI	Baheri
BHID	Bhidi
BHJ	Barhaj Bazar
BHJA	Bheja
BHK	Badhari Kalan
BHKA	Bahira Kalibari (hal
BHKD	Bhurkunda
BHKH	Baghoi Kusa
BHKL	Bhakrauli
BHL	Bhilwara
BHLA	Behula
BHLE	Barahat
BHLG	Bajaj Hindustan Ltd SDG Golagokarannath
BHLI	Bohali
BHLK	Bhalki
BHLP	Bhulanpur
BHM	Bahram
BHMA	Baghmara Halt
BHME	Bhandaridah
BHMW	Bhambhewa
BHN	Bhuli
BHNA	Bhayna
BHNE	Bhone
BHNG	Bhalukpong
BHNP	Bishanpur Halt
BHNS	Bhansi
BHNW	Bharuch New
BHOI	Dhandarikalan Block Hut (Bhoi)
BHOJ	Bhoj (Padra)
BHP	Bolpur S Niktn
BHPA	Bahrupiya Halt
BHPI	Bichhupali
BHR	Bhadreshwar
BHRB	Bhairabi
BHRH	Bhuyar P. H.
BHRJ	Bechraji
BHRL	Bharoli Jn
BHRM	Bishramganj
BHS	Vidisha
BHSA	Bhisa Halt
BHT	Bhattu
BHTA	Bhatiya
BHTH	Bhairopatti Halt
BHTK	Bhanwar Tonk
BHTL	Bhatel
BHTN	Bhitoni
BHTR	Bhatpar Rani
BHTS	Bhatasa
BHU	Bhandu Motidau
BHUA	Bhua
BHUJ	Bhuj
BHUL	Bhauli
BHUN	New Bhandu
BHV	Bhoma
BHVP	Bhavpura
BHW	Barharwa Jn
BHWA	Bechhiwara
BHWD	Bhujvad
BHWR	Bhitiharwa Ashram
BHWY	Block Hut, Waltair Marshalling Yard
BHX	Bulluana
BHY	Bhayavadar
BHZ	Bihara
BI	Bari Sadri
BIA	Bhilai
BIB	Birpur
BIC	Bichia
BICI	Barkichanpi
BID	Bidadi
BIDD	Bidiyad
BIDR	Bidar
BIE	Bhistenhatti
BIEC	Baikunth East Cabin
BIF	Bhaironpur
BIG	Belgahna
BIGA	Bigga
BIGH	Bagrigram Halt
BIGJ	Bibiganj
BIGN	Baigani
BIH	Bairagarh
BII	Boridra
BIJ	Birnagar
BIJR	Bijoor
BIK	Bhira Kheri
BIL	Bhilupur
BILA	Bheslana
BILD	Bildi
BILK	Bilkha
BILP	Bhilpur
BIM	Bilimora Jn
BIML	Bhimal
BINA	Bina Jn
BINR	Brij Nagar
BIO	Bordi
BIOP	Bellary Iron Ores Pvt Ltd
BIP	Bahilpurwa
BIPR	Bheempura
BIQ	Bansi Paharpur
BIR	Bir
BIRA	Bira
BIRD	Bhivandi Road
BIRL	Biraul
BIRP	Birarajpur
BIRT	Biratoli
BIS	Biswa Bridge
BISH	Bishengarh
BIV	Bamhani Banjar
BIWK	Bisalwas Kalan
BIX	Bhind
BIY	Bardoli
BIYA	Baniyana
BIZ	Baihata
BJ	Bahjoi
BJA	Bijrotha
BJBA	Bijbiara
BJCS	Bhilai Jaypee Cement Limited, Sakariya
BJD	Barejadi
BJE	Bhojudih Jn
BJF	Bijni
BJG	Bajrangarh
BJI	Bijauli
BJIH	Bijuli Halt
BJIL	Birla Jute & Industries Ltd . Budge Budge
BJK	Bijora
BJKN	Bajekan
BJL	Brahmajan
BJLP	Barai Jalalpur
BJM	Bhagavathipuram
BJMA	Burj Mohar
BJMD	Bara Jamda
BJMR	Baijnath Mandir
BJMS	Bally Jute Mills SDG Bally
BJN	Bejnal
BJNR	Bijainagar
BJO	Bijnor
BJP	Vijayapura
BJPD	Bajipada
BJPL	Baijnathpaprola
BJPR	Bijaipur Road
BJQ	Baghora
BJR	Barrajpur
BJRA	Bhajera
BJRI	Bijuri
BJSP	Bonjemahari Colly. SDG
BJT	Bajpatti
BJU	Barauni Jn
BJUD	Bajud
BJV	Bijauria
BJW	Bajva
BJWG	Bajwa Grp Jam Public Sdg, Gop (Jam)
BJWS	Bojawas
BJY	Bangalbaree
BK	Bakra Road
BKA	Barkhera
BKAC	Barkakana Avoiding Cabin
BKC	Bhikamkor
BKCA	Bokaro A Cabin
BKD	Bhankoda
BKDC	Outward Yard 'd' Cabin of M/S. Bsl
BKDE	Budhakhera
BKDR	Begunkodar
BKEC	Inward Yard 'e' Cabin of M/S. Bsl
BKEY	Empty Yard of M/S. Bsl
BKF	Bhikhna Thori
BKFO	Bokaro Steel City Central Freight Office
BKG	Banka Ghat
BKGS	Bakudi General Siding
BKH	Bankhedi
BKHA	Block Hut A (NER)
BKHP	Bhikampur (Halt)
BKHR	Bakhri
BKI	Bandikui Jn
BKIR	Bakudi Ircon Siding
BKIT	Binkadakatti
BKJ	Barkur
BKKA	Bhukarka
BKKI	Bakarkudi
BKKS	Bakas
BKL	Bona Kalu
BKLA	Bakulha
BKLC	Barkakana Linc Cabin
BKLE	Bakudi
BKMT	Bakudi Malitok Siding
BKN	Bikaner Jn
BKNA	Bakaina Halt
BKNG	Bhakti Nagar
BKNM	Bankra Nayabaj
BKNO	Bikna
BKO	Bindki Road
BKP	Bakhtiyarpur Jn
BKPL	Bakhtiyarpur Link
BKPR	Bakaspur
BKPT	Bhakarapet
BKRD	Bhaluka Road F
BKRH	Brij Kishor Halt
BKRI	Bharat Petroleum Corp Ltd - Kr
BKRL	Bakrol
BKRO	Bokaro Thermal
BKS	Balikotia
BKSA	Bakhsha
BKSC	Bokaro Steel City
BKSL	Bikramshila
BKSN	Bksc North Cabin
BKT	Bakshi ka Talab
BKTB	Bindukuri
BKTH	Baikunth
BKTL	Baktal
BKTS	Bakothikhas Halt
BKTU	Bari Khatu
BKTW	Baikunth West Cabin
BKU	Bhiknur
BKWA	Bakayanwala
BKWC	Baikunth West Cabin
BL	Valsad
BLA	Bajalta
BLAE	Balarambati
BLAX	Barlai
BLBT	Biratoli, Line No.1
BLC	Bolda
BLCA	Beas Block Cabin
BLCB	Balumath Line No.1 CCL Sdg.
BLCC	Bukru, Line No. 1 CCL Siding
BLCL	Bukru, Line No. 4 CCL Siding
BLD	Bhilad
BLDA	Belda
BLDI	Bhildi Jn
BLDK	Balauda Takun
BLDL	Balle-da-Pir-Larath
BLDR	Baidana Road
BLEY	Bhilai Exchange Yard
BLF	Balajan
BLG	Bilhar Ghat
BLGA	Belagula
BLGH	Bishalgarh
BLGJ	Belanganj
BLGR	Balangir
BLGT	Balurghat
BLH	Belgharia
BLHI	Bisalehalli
BLHR	Balahapur Halt
BLJA	Bhalojala Halt
BLK	Belakoba
BLKR	Ballekere Halt
BLL	Bantanahal
BLLI	Balli
BLLT	Ballupete
BLM	Balamu Jn
BLME	Bholldih
BLMK	Bhalumaska
BLMR	Bhalukmara
BLN	Ballygunge Jn
BLND	Bolinna Doaba
BLNG	Barlanga
BLNI	Bhalwani
BLNK	Belanki
BLNR	Birlanagar
BLO	Bhulon
BLP	Balrampur
BLPA	Bilasipara
BLPE	Balapalle
BLPL	Baiel Pipariya
BLPR	Badulipar
BLPS	Barharwa Lower Public Siding
BLPU	Bilpur
BLQR	Bilaspur Road
BLR	Balganur
BLRA	Bilara
BLRD	Bala Road
BLRE	Belsiri
BLRG	Balasiring
BLRI	Belari Halt
BLRR	Belandur Road
BLS	Balasore
BLSA	Bolsa
BLSD	Balsamand
BLSG	Bokaro Steel Ltd Siding Khbj
BLSN	Belsonda
BLSR	Belasar
BLSS	BPCL Siding Surat
BLT	Balotra Jn
BLTR	Belthara Road
BLU	Bilhaur
BLUR	Beas Military Ramp Siding
BLV	Bhelwa
BLW	Balawali
BLWD	Bolwad
BLWR	Bileshwar
BLX	Bolai
BLY	Bally
BLYC	Bally Chord
BLYG	Bally Ghat
BLYH	Bally Halt
BLZ	Budhlada
BM	Bodma
BMA	Bagmar
BMAE	Belmuri
BMAP	Bammapur
BMB	Bamra
BMBE	Bimbari
BMC	Bhimalgondi
BMCK	Bissamcuttack
BMCO	M/S. Balaji Movers & Siding Pvt. Ltd. of Gcto
BMCY	Bondamunda Classification Yard
BMD	Bhimadolu
BMDI	Brahmanwada
BMDR	Bamandongri
BMDY	Bondamunda Departure Yard
BME	Barmer
BMEY	Bondamunda Exchange Yard
BMF	Basmat
BMG	Bamangachhi
BMGA	Bhimgara
BMGM	Brahmanagudem
BMGN	Bamunigaon
BMGR	Bamangram
BMH	Betamcherla
BMHR	Bamanheri
BMHT	Baraw More
BMI	Bamnia
BMJ	Bridgmanganj
BMK	Birang Khera
BMKD	Bellamkonda
BMKI	Bapudm Motihari
BMKJ	Bhimkhoj
BMLL	Bamla
BMM	Bhaskarpara
BMMP	Bommayapalli
BMN	Bhimana
BMNI	Bamani
BMNL	Baman Wali Halt
BMO	Bolarum
BMP	Bramhapuri
BMPE	Brahmanapalle
BMPL	Brahmanpalli
BMPR	Badampahar
BMPT	Banni Mahamman Patti
BMQ	Bhimarlai
BMR	Bikrampur
BMRN	Bhimrana
BMRS	Bondamunda Roh Shed
BMSB	Bhimasar BG
BMSL	Bondamunda Medium Sick Line
BMSN	Bamsin
BMSR	Bhimasar
BMT	Begampet
BMU	Bamhrauli
BMVR	Bhaner Minawada
BMW	Bamhani P. H.
BMWS	Bamanwas
BMX	Bamankuva
BMY	Bamiana
BMZ	Bamour Gaon
BN	Bibinagar
BNA	Banni Koppa
BNAA	Bibhuti Bhushan H
BNAR	Binaur
BNB	Banstola
BNBA	Bimanbandar
BNBH	Bani Bihar
BNBR	Bahanaga Bazar
BNC	Bengaluru Cantt
BNCB	Bharat Earth Movers SDG-Gn S/B Bypl
BNCE	Bengaluru East
BNCR	Banchari
BND	Bhandup
BNDA	Banda Jn
BNDE	BNDE Station
BNDG	Bandag Siding
BNDI	Barundini
BNDM	Bondamunda
BNDN	Bhandana
BNDP	Buniadpur
BNDR	Bhanduri
BNE	Bohani
BNF	Bandhua
BNG	Barnagar
BNGD	Boisar New Goods Shed
BNGL	Bhangala
BNGM	Bangurgram
BNGN	Bongaigaon
BNGO	Bingaon
BNGS	M/S. Shree Cement Co. Ltd.
BNGY	Babhanjyotiya Halt
BNH	Bhimnath
BNHL	Bellenahalli
BNHR	Banbihari - Gwalipur
BNHT	Bannihatti
BNI	Budni
BNJ	Bangaon Jn
BNJH	Baranjh
BNJL	Binjhol Halt
BNJN	Binjana
BNK	Banasankarai Halt
BNKA	Bankim Nagar
BNKH	Bhairanayakanahalli
BNKI	Banmankhi Jn
BNKJ	Banke Ganj
BNKM	Vinaekma Halt
BNKT	Bankat Halt
BNL	Bevinahalu
BNLS	Bangi Nihalsngh
BNLW	Banasthali Niwai
BNLY	Bhanupli
BNM	Baragaon
BNN	Barnala
BNNR	Bhindar
BNO	Banar
BNOD	Benoda
BNOI	Bindori
BNP	Bhanapur
BNPA	Baniapur Halt
BNPD	Bank Note Press Siding Dewas
BNPH	Basantpur
BNPL	Bondapalli Halt
BNPR	Banikpur Halt
BNPT	Benipati Pirapur
BNQ	Banarhat
BNQL	Bhankala Halt
BNR	Bhagwanpur
BNRD	Balangir Road
BNRN	Bagdogra Military Siding
BNRS	Banaras
BNS	Banas
BNSA	Banbasa
BNSG	Banmor Siding
BNSL	Bansinala Halt
BNSN	New Banas
BNSP	Bansapahar Jn
BNSR	Bhagwan Sar
BNT	Bharthana
BNTH	Bandhnath
BNTL	Bantawala
BNU	Bandakpur
BNV	Binnaguri
BNVD	Bhanvad
BNW	Bhiwani Jn
BNWC	Bhiwani City
BNWD	Bhandewadi P. H.
BNWS	Bhanwsa
BNXR	Bidhan Nagar
BNY	Barhni
BNZ	Badshahnagar
BO	Borsad
BOA	Baheriya Road
BOBS	Bobas
BOCB	Belpahar Open Cast Mine III
BOCM	Belpahar Open Cast Mines (Bocm-1)
BOD	Bangrod
BODG	Bodagram
BOE	Barsoi Jn
BOF	Barog
BOG	Bhairongarh
BOI	Bainchi
BOJ	Bhojo
BOK	Borkhedi
BOKA	Bokra
BOKE	Bhoke
BOKO	Boko
BOKR	Bhokar
BOM	Bomadra
BOMB	Belpahar Open Cast Mines (Bocm-6)
BOMK	Baroud Oc Mines Siding of SECL
BOMN	Bommagundanakere
BON	Bhonra
BONA	Boinda
BOP	Bhogpur
BOR	Boisar
BORA	Baghdogra
BORD	Bolagarh Road
BORT	Bolagarh Town PH
BOT	Boroti
BOTI	Baori Thikaria
BOTR	Bhavdhari
BOUH	Boudh
BOV	Bhatgaon
BOW	Borawar
BOX	Bhojasar
BOY	Bhadohi
BOYA	Bothiya
BOZ	Bolarum Bazar
BP	Barrackpore
BPA	Belampalli
BPAE	Begumpur
BPAG	Bharat Petroleum Ltd., Asoti
BPAH	Benipur A Halt
BPAJ	M/S BPCL Siding
BPAL	M/S BPCL Private Siding
BPB	Badarpur Jn
BPBS	Ballalpur
BPBW	Bedi Port Terminal Served By Bedeshwar Windmill
BPC	Berhampore Crt
BPCB	BPCL Siding Bijwasan
BPCC	BPCL Sdg, Cheppad
BPCG	Bharat Petroleum Oil Corporation Ltd. Siding
BPCI	BPCL Sdg, Irumpanam
BPCK	BPCL Siding Katihar
BPCL	BPCL Siding Narayanpur Anant
BPCM	Bpc Ltd Siding, Ddu
BPCP	Pol Sdg. For M/S BPCL Panevadi
BPCR	BPCL Siding, Karari
BPD	Bahadurpur
BPE	Benapur
BPF	Banapura
BPG	Badurpur Ghat
BPGH	M/S BPCL Hirenanduru
BPGJ	Bharpura Pahleja Ghat Jn
BPGK	M/S Bharat Petroleum Corporation Limited
BPGR	Benipurgram Halt
BPH	Belpahar
BPHB	Bhilai Power House
BPHI	Baiyyappanahalli Cabin
BPHT	Power House Siding
BPI	Bye Pass I
BPII	Bye Pass II
BPJ	Bara Hapjan
BPK	Bhugaon
BPKA	Bhopalka
BPKH	Budha Pushkar
BPKR	Bpc Ltd Siding (BG) - Khari Rohar Road
BPL	Bhopal Jn
BPM	Bagpat Road
BPMG	Bharat Petroleum Corporation Limited Siding Mangliyagaon
BPMH	Bishunpur Mahuari
BPMS	Bengdubi Military Project Siding (BG)
BPN	Banpur
BPNA	BPCL Siding Narayanpur Anant
BPO	Baripada
BPOB	Bharat Pertoleum Oil Depot Siding
BPOI	Bharat Petroleum Corporation Ltd. Private Siding
BPOL	BPCL Siding , Bad
BPP	Bapatla
BPPS	Barrackpore Racecourse SDG (for Mily Only) Barrackpore
BPQ	Balharshah
BPQX	Balharshah Yard
BPR	Bhojipura Jn
BPRA	Baripura
BPRD	Barpeta Road
BPRG	M/S Bpcl's GCT At Radhagaon
BPRH	Balpur Halt
BPRS	Bhogpur Sirwal
BPS	Banpas
BPSH	Barharwa Public Siding
BPSL	M/S Bhushan Power and Steel Ltd
BPSR	Bengal Paper Mill SDG Ranigunge
BPTA	Indira Dock
BPTB	Ballard Pier
BPTC	Cotton Depot (cotton Green,crawford Market )
BPTG	Grain Depot
BPTO	Oil Depot
BPTP	Bhanupratappur
BPTS	Stores Depot
BPTV	Victoria Dock Bpt Rly
BPTW	Wadala
BPU	Bhaupur
BPUN	New Bhaupur Jn
BPUR	Baidpur
BPV	Bhotepatti
BPVS	Bharat Heavy Plants and Vessels Siding, Vpt
BPW	Burhpura
BPY	Badampudi
BPZ	Bazpur
BPZA	Bharathapuzha Halt
BQA	Bankura
BQE	Bakanian Bhaunri
BQER	Bakanian Bhaunari Reliance
BQF	Barahmuafi
BQG	Bhagwangola
BQH	Bhanohad Punjab
BQI	Bommidi
BQM	Barelipar
BQN	Bagri Nagar
BQP	Bighapur
BQQ	Bakhleta
BQR	Bhilainagar
BQSP	Basuachak Halt
BQT	Baktar Nagar
BQTG	Bakhtarnagar Link Goods Line
BQU	Bhattiprolu
BQW	Barakalan
BQY	Belerhat
BQZ	Ballalpur
BR	Bandh Bareta
BRA	Birsola
BRAG	Barang Jn
BRAH	Bridge & Roof Co Assists. SDG HWH
BRAM	Balarampuram
BRAS	Barora Rly Assisted Sdg, Katrasgarh
BRB	Boribial
BRBC	Barpali Road
BRBD	Borabanda
BRBG	Barbigha
BRBH	B R Border Halt
BRBL	Birahalli
BRBR	Barbera
BRBS	Birbans PH
BRC	Vadodara Jn
BRCK	Barua Chak
BRCY	Vadodara Marshalling
BRD	Bhandara Road
BRDA	Baradiya
BRDB	Barda
BRDH	Bardhana
BRDT	Beria Daulat
BRDV	Baradev
BRE	Bharwari
BRG	Bargarh
BRGA	Bargarh Road
BRGJ	Bargaon Gujar
BRGL	Burgula
BRGM	Baraigram Jn
BRGP	Bajrangpura
BRGT	Bheraghat
BRGW	Bargawan
BRGY	Vadodara D Cabin
BRGZ	Vadodara 'e' Cabin
BRH	Baikunthpur Road
BRHD	Baba Raghuni Halt Dwarika
BRHI	Barhi
BRHL	Baryal Himachal
BRHM	Barhragram Halt
BRHU	Barahu
BRI	Bhiringi
BRIH	Bairi Halt
BRIP	Barogopinathpur
BRJ	Brace Bridge
BRJN	Brajrajnagar
BRK	Bahraich
BRKA	Barka Kana
BRKB	Bharat Khand
BRKD	Bharat Khand
BRKH	Bisapur Kalan Halt
BRKM	Bahraich (MG)
BRKN	New Boraki Jn
BRKP	Barkipona
BRKY	Boraki
BRL	Barwala Road
BRLA	Barayala Chaurasi
BRLF	Barlongfer
BRLN	New Biroliya
BRLY	Biroliya
BRM	Barabambo
BRMA	Barmasia
BRMD	Biramdih
BRMH	Belur Math
BRMI	Brahmani PH
BRML	Baramula
BRMO	Bermo
BRMP	Birmitrapur
BRMR	Bharmar
BRMS	Mani Pahar Sdg, Birmitrapur
BRMT	Baramati
BRMX	Barmi
BRN	Barhan
BRNA	Berawanya
BRND	Boridand Jn
BRNI	Barwasni Halt
BRNR	Baruanagar
BROD	Baroud
BROL	Pol Sdg. For M/S BPCL
BROR	Berore
BRP	Baruipur Jn
BRPA	Baruipara
BRPH	M/S Bridge & Roof Pvt SDG HWH
BRPK	Bisharpara Kodalia
BRPL	Barpali
BRPM	Baripur Mandala
BRPN	Bongaigaon Refinery & Petrochemical P Ltd
BRPS	Barapalasi
BRPT	Birapatti
BRQ	Bagrakot
BRR	Barakar
BRRB	Bargawan Railway Coal Siding
BRRD	Bordi Road
BRRG	Biyavra Rajgarh
BRRI	Birari
BRRK	Barora Washery Colliery Siding
BRRZ	Barara Buzurg
BRS	Birsinghpur
BRSA	Barwa Kalan
BRSB	Private Siding of M/S Bharatiya Reserve Bank Note Mudran (P) Ltd
BRSG	Bharat Petroleum Siding
BRSM	Bina Refinery Plant Siding
BRSQ	Brar Square
BRSR	Biranarsinghpur
BRST	Birpurusothampr
BRT	Brahmavart
BRTA	Bartara
BRTG	Barithengarh
BRTK	Bhortex
BRTL	Bharthali
BRU	Bhairoganj
BRUD	Barud
BRVR	Borvihir
BRW	Bariwala
BRWD	Barwadih Jn
BRWH	Baherwa Halt
BRY	Bareilly Jn
BRYA	Barhiya
BRYC	Bareilly Cantt
BRZ	Bareta
BS	Benisar
BSA	Bhainsa
BSAE	Bansh Baria
BSAR	Bhaiyasar
BSAU	Bavana Sai Associate Siding Serving Apswc
BSB	Varanasi
BSBH	Bhainsbodh P. H.
BSBN	Bhusawal B Cabin
BSBP	Bir Shibpur
BSBR	Bansloi Bridge
BSBS	Banaras
BSBY	Varanasi Yard
BSC	Bulandshahr
BSCD	New Bulandhahr
BSCK	Basuchak
BSCN	Bhusawal C Cabin
BSCP	Baskatwa B. H.
BSCS	Bokaro Steel Plant
BSD	Basuldanga
BSDA	Baniya Sanda Dh
BSDB	Ballast Rly Sdg,dayabasti
BSDC	Birds Sonda Colliery Siding
BSDL	Bharsendi
BSDP	Bhusandpur
BSDR	Bansadhara PH
BSE	Badshahpur
BSET	Bses Thermal Power Plant
BSGD	Bais Godam
BSGH	Bothra Shipping and Services and Gupta Trading Co.
BSGN	Basugaon
BSGR	Bhagsar
BSGS	Bhusaval Goods Yard
BSHT	Basirhat
BSI	Basbari
BSIM	Bihar Sponge Iron Ltd
BSIP	Bhavnagar Salt Industries Ltd. Sdg, Bhavnagar
BSJ	Bhupalsagar
BSK	Ballast Siding
BSKH	Basukinath
BSKN	Bhesana Manknaj
BSKO	Banskho
BSKR	Basi Kiratpur
BSL	Bhusaval Jn
BSLA	Bhasila
BSLE	Bataspur
BSLX	Bhusaval Jn Yard
BSM	Bisanattam
BSMA	Acb Block Hut
BSMH	Birshamunda Halt
BSN	Banasandra
BSNJ	BPCL Siding - Njp
BSNP	Bishunpur
BSP	Bilaspur Jn
BSPB	Barh Super Thermal Power Project
BSPC	SAIL Bhilai
BSPD	Biaspind
BSPH	Bishanpur Hryna
BSPK	Bispur
BSPL	Basampalle
BSPN	Bassi Pathanam
BSPR	Bishrampur
BSPS	Burmah Shell Pol Tank Storage SDG . (BPCL) S/B Budge B
BSPX	Banspani
BSQ	Barsi Takli
BSQP	Bansipur
BSR	Vasai Road
BSRA	Basarhia Halt
BSRI	Basari
BSRL	Besroli
BSRX	Basavana Bagewadi Road
BSS	Bahadur Singh W
BSSG	Reserve Petrol Depot Siding
BSSL	Basi Beriasal
BST	Basti
BSTC	Bharatpur Silo Siding of Mahanadi Coalfields Limited
BSTP	Basantapur
BSUR	Bisalpur
BSW	Baneswar
BSWA	Baiswara
BSWD	Bhenswadi
BSX	Basar
BSY	Barsathi
BSYA	Barkisalalya
BSZ	Bharwa Sumerpur
BT	Barasat
BTA	Bihta
BTBR	Buti Bori
BTC	Balaghat Jn
BTCC	Bathinda C Cabin
BTCP	Bhanora (S) Colliery SDG
BTD	Botad Jn
BTDA	Bhathondha Halt
BTDF	Botad MG
BTDR	Batadrowa Road
BTE	Bharatpur Jn
BTF	Bathnaha
BTG	Basharatganj
BTGA	Bhutgoria
BTGH	Bettadnagenhali
BTH	Bettiah
BTHL	Bithauli
BTHN	Bithan
BTI	Bathinda
BTIA	Bathinda A Cabin
BTIB	Bathinda B Cabin
BTIC	Batinda Cantt
BTJ	Bishnathganj
BTJL	Bhatkal
BTK	Bankata
BTKB	Bathna Kritti Bas
BTKD	Bharatkund
BTKP	Bharat Kup
BTL	Bortalao
BTM	Battulapuram
BTMT	Bandel Thermal Power Station
BTNG	Bhatta Nagar
BTNR	Bharatnagar
BTO	Bhitaura
BTP	Babatpur
BTPB	Bokaro Thermal Power SDG
BTPC	Bakreswar Thermal Power Plant SDG
BTPD	Bethampurdi
BTPG	Betheria Ghola
BTPH	Chakia Thermal Halt
BTPK	New BG Btps (bellary Thermal Power Station) Siding
BTPR	Bhatpur
BTQ	Betnoti
BTR	Butari
BTRA	Banthra
BTRB	Betur
BTRH	Bhatar
BTRI	Bitroi
BTRO	Bastoi Halt
BTS	Basta
BTSD	Bhatisuda
BTSI	Batasi
BTSR	Bhuteshwar
BTSS	Barauni Thermal Power Station Siding
BTT	Bhatni Jn
BTTN	Bhatian
BTTR	Bitragunta
BTU	Baraut
BTV	Baitarani Road
BTVA	Batuva
BTW	Barsi Town
BTWN	Betwa Cabin
BTX	Bela Tal
BTY	Bethuadahari
BTYA	Bhatariya
BTZ	Balimara
BU	Baswa
BUA	Baradwar
BUB	Bissau
BUBA	Bijubigha Halt
BUBR	Bhutakia Bhimsa
BUBT	Buraha Bharthara
BUD	Badlapur
BUDA	Bhuda
BUDI	Bundi
BUDM	Badmal
BUDR	Baudpur
BUE	Baruna
BUF	Bimalgarh Jn
BUG	Bagaha
BUGL	Buglanwali
BUGM	Berugram
BUGN	Bhurjiha Baragn
BUGY	Bugia Halt
BUH	Burhar
BUI	Ballia
BUJ	Barauni Flag
BUJA	Bhujia
BUKR	Bukru
BUL	Bhalulata
BUM	Bommasamudram
BUMA	Bhalumuda
BUMH	Balumath
BUP	Bariarpur
BUPH	Babupeth
BUQ	Bargi
BUR	Bindaura
BURA	Bahuara Halt
BURN	Burnpur
BUS	Badausa
BUT	Baytu
BUTA	Bhadutala
BUTN	Butana Halt
BUU	Bhadanpur
BUW	Burhwal Jn
BUX	Bhandak
BV	Babhnan
BVA	Bauria
BVAC	Bhimavaram A Cabin
BVAR	Bevara
BVB	Bhadbhadaghat
BVBC	Bhimavaram B Cabin
BVC	Bhavnagar Terminus
BVCJ	Bhavnagar Concrete Jetty
BVH	Ballabgarh
BVI	Borivali
BVL	Bikkavolu
BVM	Bayyavaram
BVN	Biswan
BVNR	Bhavani Nagar
BVO	Bogolu
BVP	Bhavanagar Para
BVQ	Bhilavdi
BVR	Banavar
BVRB	Bhavnagar Docks
BVRM	Bhimavaram Jn
BVRT	Bhimavaram Town
BVS	Bhivpuri Road
BVTD	Bhavnagar Bunder Timber Depot
BVU	Balipara
BVV	Bedetti
BVW	Bahminiwala
BVZ	Naloi Barwa
BW	Biwai
BWA	Bhinwaliya
BWB	Bagwali
BWBN	Bewar Bhojan
BWC	Banwali
BWCM	Bharat Wagon and Engg Co Ltd Siding
BWCN	Bowaichandi
BWD	Belvandi
BWEM	Bharat Wagon and Engg Works Mokama
BWF	Butewala
BWH	Bhadaura
BWI	Bilwai
BWIP	Bhawanipatna
BWJ	Barwadag
BWK	Bawani Khera
BWL	Bawal
BWM	Bhawani Mandi
BWN	Bardhaman
BWND	Barddhaman Dn Yard
BWNG	Box Wing
BWNU	Barddhaman Up Yard
BWO	Buramara
BWP	Bhawanipur Kaln
BWPB	Bhawanipur Bihar
BWPL	Balwant Pura
BWR	Barwa Sagar
BWRA	Bharatwada
BWS	Badwasi
BWSB	Bhojudih Coal Washery Siding
BWSN	Bijwasan
BWT	Bangarapet Jn
BWV	Bhiwapur
BWW	Barwaha
BWWL	Bina Wharfwall Siding
BWX	Bahman Diwana
BWZ	Baddowal
BXA	Balod
BXB	Banga
BXC	Barwala
BXF	Barsuan
BXG	Bhanga
BXHT	Boxirhat
BXJ	Bokajan
BXK	Bandarkhal
BXL	Bheduasol
BXLL	Billi
BXM	Belrayan
BXN	Bayana Jn
BXO	Boparai
BXP	Barpathar
BXQ	Brundamal
BXR	Buxar
BXS	Pichchandarkovl
BXT	Bamanhat
BXW	Barddhaman
BXY	Bordhai
BY	Byculla
BYC	Ballari Cantt Halt
BYC2	Ballari Cantt BG (Bellary)
BYCH	Ballari Cantonment Halt
BYD	Byadgi
BYE	Bansi Bohera
BYFS	Bolani Fine Ore of M/S Bsl
BYH	Bhiti
BYHA	Barya Ram
BYKT	Burakayalakota
BYL	Belha
BYN	Banahi
BYNR	Mookambika Road Byndoor (H)
BYO	Bayaluvaddigeri
BYP	Baijnathpur
BYPA	Baiyyappanahalli Auxiliary Bypass Cabin
BYPL	Baiyyappanahalli
BYPW	Baiyyappanahalli West Cabin
BYPY	Baiyyappanahalli Yard Cabin
BYQ	Bahai
BYR	Bhayandar
BYS	Barsali
BYSA	Basulyasutahata
BYT	Bhatapara
BYX	Bolanikhadan
BYXA	Betgara
BYY	Byree
BYZA	Begunia
BZ	Bharur
BZA	Vijayawada Jn
BZAY	Vijayawada Yard
BZB	Barra Bazar
BZC	Beliator
BZE	Baseria
BZG	Bilga
BZGT	Bazurghat
BZJT	Bazida Jatan
BZK	Bhaini Khurd
BZL	Belanagar
BZLE	Bazarsau
BZM	Bhimsen
BZMN	New Bhimsen Jn
BZN	Bagnan
BZO	Barsola
BZR	Bisra
BZS	Bansjora
BZU	Betul
BZY	Basai
C	Kidderpore Docks
CAA	Chakia
CABN	Bhilai Cabin
CAC	Chand Pipar Halt
CACS	Chhota Ambana Concrete Sleeper SDG
CAER	Chhanera
CAF	Chanda Fort
CAG	Chhabra Gugor
CAI	Chanpatia
CAJ	Chakraj Mal
CAM	Chhota Ambana
CAMU	Chamua
CAN	Kannur
CAO	Chauradano
CAP	Chatrapur
CAPC	Chatrapur Court
CAPE	Kanniyakumari
CAPG	Chapaguri
CAR	Chunar
CARD	Charadu Halt
CAS	Chas Road
CASA	Chhansara
CASK	Chickka-Shellikeri
CAT	Chattar Hat
CATA	Chhata Aschaura
CATD	Chataud P. H.
CAZ	Chauhani
CBBH	Chudiala Block Hut
CBCC	Chandlodiya B
CBCK	Chanch Branch Jb Mata Colliery. Sdg.
CBD	Changrabandha
CBDH	Cbd Naya Raipur
CBE	Coimbatore Jn
CBF	Coimbatore North Jn
CBFB	Food Corporation of India Grain Godown S
CBG	Charbhuja Road
CBH	Chaube
CBJ	Clutterbuckganj
CBJS	Scrap Depot Rly SDG Clutterbuck Ganj
CBK	Chachura Binagani
CBKB	CONCOR Siding Bhagat ki Kothi
CBM	Cumbum
CBN	Chit Baragaon
CBP	Chik Ballapur
CBR	Chaubepur
CBRS	Chunch Br. Sdg.(sridurga Silicate of Soda Fy & Rice Mill) Ba
CBS	Chunbhati
CBSA	Chaibasa
CBSP	Cargo Berth Siding At Paradeep Port.
CBT	Charbatia
CBU	Chinnababusamudram
CBX	Chand Bhan
CBY	Khambhat
CBZ	Churaibari
CC	Chauri Chaura
CCA	Chigicherla
CCAB	Bhilai C Cabin
CCBG	Chicholi Buzurg P. H.
CCCT	M/S Chettinad Cement Corporation Pvt. Ltd.
CCD	Chichonda
CCG	Churchgate
CCH	Chinchvad
CCHR	Chhachhar
CCI	Chinnekuntapali
CCIB	Cement Corporation of India (Pvt/BG) Siding, Bokajan
CCIJ	Cci Siding - Jud
CCIK	Cotton Corp. of India Ltd.
CCIL	Continental Carbon India Ltd Siding
CCIP	Cement Corporation of India Ltd.
CCIS	Cement Corpn India Kurgunta
CCJS	Pft of CONCOR
CCK	Chichaki
CCL	Chanchelav
CCLW	Cclink-West
CCMH	Pft of M/S. Container Corporation of India Limited
CCMP	CONCOR Siding Mandidip
CCO	Chicholi P. H.
CCP	Chhuchhapura Jn
CCPP	CONCOR Private Siding
CCR	Chinchuria
CCRL	Cc Rly Link Cabin
CCSB	Churcha Colliery
CCSJ	Jamtara Siding
CCSP	Chasnalla (t. B.sdg)
CCSR	Churi Sdg, Ray
CCSS	Chelode A Colly. SDG
CCST	Cement Corporation of India, Tandur
CCT	Kakinada Town
CCTA	CONCOR Depot
CCTB	CONCOR Container Terminal Siding Vadodra Yard
CCTC	M/S Chettinad Cement Corporation Private Limited
CD	Chandrapur
CDA	Chuda
CDAE	Chandanpur
CDB	Chaudhribandh
CDBH	Chandrabanda Halt
CDBN	Chedhabanni Halt
CDD	Chandod
CDG	Chandigarh
CDGR	Chandrakona Road
CDH	Chakdaha
CDI	Chandni
CDK	Chandkhera Road
CDL	Chodiala
CDM	Chidambaram
CDMA	Chandeshwarsthan
CDMR	Chandauli Mjhwr
CDNR	Chandanagar
CDP	Chandpara
CDQ	Chadotar
CDQN	New Chadotar Jn
CDRA	Chandera
CDRG	Chandrugonda
CDRL	Chhandrauli
CDRN	Chakradhar Nagar
CDS	Chandisar
CDSL	Chandresal
CDSN	Container Depo Siding New Ngsm
CDV	Chandarwa
CE	Chharodi
CEBD	Private Siding of Commercial Engineers & Body Builders Company Limited
CECC	Chadotar End Cabin
CECP	Cka East Koliary Siding
CED	Cossipore Road
CEDC	Cossipore Container Rail Terminal
CEL	Chebrol
CEM	Cheekateegalplm
CEME	Chegro
CESC	M/S Cesc Cossipore Ltd. Sdg, Ced.
CESG	Associated Cement Co. S. Siding-Ghugus.
CEU	Chiheru
CFCC	Changsari FCI Siding (Pvt) (BG)
CFCS	Cfcl-Bon
CFCV	Container Freight Station Vskp
CFDI	Central Food Depot Pvt . SDG (FCI) Budge Budge
CFDJ	Gfd FCI Siding (A) (P) (BG)
CFDS	The Associated Cement Co Ltd, Unit Bargarh Cement Works
CFFK	Cattlefeed Factory Sdg, Kanjari
CFG	Chakiting
CFS	Food Corpn of India Sanatnagar
CFSL	Ggfc Siding, Lucknow
CFVS	Coromandel Fertilizer Ltd Siding Vpt
CG	Canning
CGA	Chengel
CGDM	CONCOR Siding Gandhidham
CGF	Charali
CGH	Cholang
CGHD	Chinnadagudihdi
CGI	Chandragiri
CGKR	Chandagirikopal
CGL	Chengalpattu Jn
CGLA	Changotola
CGM	Chargaon Colliery Sdg.
CGMD	Gati Shakti Multi-Modal Cargo Terminal of M/S CONCOR From Dahej
CGMV	Gati Shakti Multi-Model Cargo Terminal of M/S CONCOR From Varnama
CGN	Chirgaon
CGO	Chhidgaon
CGON	Chaygaon
CGPT	M/S. CONCOR Green Field Pft
CGR	Chandan Nagar
CGS	Changsari
CGTA	Chegunta
CGV	Chingavanam
CGVS	Food Corporation of India Grain Godown Sdg, Cgv
CGX	Chargola
CGY	Changanasseri
CGYN	New Changa
CH	Chandausi Jn
CHA	Chawapall
CHAA	Chapar
CHAF	Chaf Halt
CHAH	Chailaha Halt
CHAN	New Chawapail Jn
CHAP	Chhattarpur
CHAR	Charmal
CHAS	Chass
CHB	Chabua
CHBD	Chennai Harbour - Bharathi Docks
CHBN	Chandkhira Bagn
CHBR	Chaure Bazar
CHBS	Chaubisi
CHBT	Chakarbhatha
CHC	Chanchai
CHCR	Chacher
CHD	Chandia Road
CHDA	Chanda Halt
CHDX	Chhada
CHE	Srikakulam Road
CHF	Chunabhatti
CHG	Chinchpokli
CHGA	Chirugoda
CHH	Chaukhandi
CHHL	Chhal
CHHU	Chhanua
CHI	Chiplun
CHIB	Chirai BG
CHIC	Port Side Container Terminal At Hom
CHIT	Chithari Halt
CHJ	Chata
CHJC	Chitoda
CHJD	Chennai Harbour - Jawahar Docks
CHK	Chakeri
CHKB	Chakki Bank
CHKE	Challakere
CHKTR	Chinna Koothanur
CHL	Chola
CHLD	Chitalda
CHLI	Chikhloli
CHLK	Chavalkhede
CHLR	Chhalesar
CHLS	Lay-Bye Siding, Chts
CHM	Chalthan
CHMG	Chintpurni Marg
CHN	Chhina
CHNH	Channi Halt
CHNN	Channani
CHNR	Chhan Arorian
CHNU	Chhanua
CHOD	Charduar
CHOK	Chowk
CHP	Chhapi
CHPA	Chhapar Halt
CHPD	Cheppad
CHPG	Chhapra Gramin
CHPT	Chatrappatti
CHQ	Choka
CHR	Chilkahar
CHRA	Chharra
CHRD	Charodiya
CHRG	Chorgi
CHRI	Charhi
CHRK	Churki
CHRM	Chirmiri
CHRU	Chamrua
CHSM	Chinna Salem
CHT	Champahati
CHTC	CONCOR - Rail Container Terminal
CHTI	Chaneti
CHTL	Churaru Takrala
CHTS	Kochi Harbour Terminus
CHTT	Chitta
CHU	Champion
CHUA	Chourai
CHV	Charvattur
CHWN	New Chaprawat
CHWT	Chhaprawat
CHY	Cochin Yard
CHZ	Charlapalli
CI	Chhapra Kacheri
CIA	Chheharta
CIAT	CIAT Station
CIC	Chand Pipar Halt
CID	Chiraidongri
CIH	Chilhia
CII	Chettiyapatti
CIIB	Caltex (india ) Ltd Budge Budge
CIK	Chiksana
CIKA	Chikana
CIKR	Chandikhole Road
CIL	Chilbila Jn
CILI	M/S Orissa Industries Ltd, Lathi Kata
CIM	Chettipalayam
CIN	Chintakunta
CIO	Chikhli Road
CIP	Chichpalli
CIPB	Cimmco Siding (served By Bharatpur)
CIRL	Chirula
CIT	Chitali
CIV	Chinnaravuru
CJ	Kanchipuram
CJA	Chongajan
CJE	Kanchipuram East
CJL	Chajli
CJM	Chinna Ganjam
CJMK	Craig Jute Mill SDG Kankinara
CJMS	Caledoniam Jute Mills Budge Budge
CJN	Chhatna
CJQ	Champajharan
CJR	Chamaraj
CJS	Charamula Kusum
CJW	Chajawa
CK	Chiksugar
CKA	Chak Pakhhewala
CKB	Chauth ka Barwara
CKBK	Chikkabenakal
CKD	Charkhi Dadri
CKDL	Chakdayala
CKE	Choki Sorath
CKG	Chowka Ghat
CKH	Chakand
CKHS	Chikhle
CKHT	Chanka Halt
CKI	Chalakudi
CKK	Chakarpur
CKKD	Charkhera Khurd
CKKN	Chak Kalan
CKLA	Chak Banwala
CKLT	Chak Kali Lait
CKM	Chauki Man
CKMI	Chhotaki Masaudhi Halt
CKN	Chinta Kani
CKNA	Chikna
CKNI	Chikni Road
CKOD	Chakrod
CKP	Chakaradharpur
CKR	Chikodi Road
CKRD	Chakmakrand
CKS	Chaksu
CKSR	Chak Safaura Halt
CKSS	Kssidc Siding
CKTD	Chitrakut Dham Karwi
CKU	Chakulia
CKV	Cherukuvada
CKVD	Chikkandawadi
CKW	Chalkhoa
CKWP	Ck West Collery SDG
CKX	Chakur
CKYD	Chakra Road
CKYR	CONCOR Siding Khodiyar
CLA	Kurla Jn
CLAS	Kurla Emu Carshed
CLC	Chalala
CLD	Chalsa Jn
CLDR	Chilikidara
CLDY	Chandlodiya
CLE	Chintalpalli
CLF	Chhulha
CLG	Kahalgaon
CLHT	Chulheta
CLI	Chalgeri
CLJ	Colonelganj
CLKA	Chilka
CLKN	Chuchela Kalan Halt
CLMD	Chullimada
CLN	Kollidam
CLO	Chilo
CLPE	Challavaripalli
CLR	Castle Rock
CLT	Kozhikkode
CLU	Chilakalapudi
CLVR	Chiluvur
CLW	Chilwariya
CLWS	Chittaranjan Locomotive Works Siding Rupnarayanpur
CLX	Chirala
CM	Campierganj
CMA	Cinnamara
CMBR	Chembur
CMC	Chemancheri
CMCN	Domestic Container Terminal Siding of M/S. CONCOR Nagalapalle
CMDG	Chamardighi
CMDP	Chimidipalli
CMGR	Chikkamagaluru
CMJ	Chamarajapuram
CMK	Chamak
CMLK	Greenfield Pft of CONCOR Neemrana Served By Kathuwas
CMMG	Chamunda Marg
CMNR	Chamarajanagar
CMP	Chromepet
CMR	Chamrola
CMSG	Central Ordinance Depot, Dehu Road
CMU	Chau Mahla
CMW	Chima Pahad
CMX	Chamagram
CMY	Chintamani
CMZ	Chalama
CNA	Chanderia
CNAS	The Birla Cement Works Siding - Chanderiya
CNB	Kanpur Central
CNBI	Chandari
CNBL	Cnbl
CNBN	New Kanpur
CNC	Chinchli
CNCP	Concor's Port Side Container Terminal
CND	Chandur
CNDB	Chandur Bazar
CNDI	Chandi Halt
CNDM	Chandi Mandir
CNDN	Chandan
CNE	Chandranathpur
CNF	Chianki
CNGP	Cesc Siding Tgh
CNGR	Chengannur
CNGT	Guntur CONCOR Siding
CNH	Chaunrah
CNHL	Chink Hill
CNI	Chandil Jn
CNJ	Chander Nagar Halt
CNJO	Juhi Outer Cabin
CNJW	Holding Line
CNK	Chandok
CNKH	Chinnakote Halt
CNKP	Chanakyapuri
CNL	Chandawal
CNLN	New Chandawal
CNM	Chengmari
CNN	Chintaman Ganes
CNO	Canacona
CNP	Cauvery North Point
CNPA	Channarayapatna
CNPI	Chandanpahari
CNPR	Chainpur
CNR	Chandar
CNRF	Chandra
CNS	Chuchura
CNV	Kinattukkadavu
CNX	Chandauna Halt
CNY	Kolanalli
COA	Kakinada Port
COAC	Kakinada Port C Cabin
COB	Cooch Behar
COD	Chhota Gudha
CODD	Delhi Cantt Cods Siding
CODS	COD Siding , Chheoki (Pcoi)
CODX	COD Siding , Kanpur
COE	Chitrod
COF	Coromandel Fertiliser Sdg, Ennore
COI	Chheoki
COIB	Combined Oil Industry At Somenathopur of M/S. HPCL
COL	Coromandel
COLS	Bharat Earth Movers Siding
COM	Chomun Samod
COO	Chhoti Odai
COP	Cooperganj Goods Shed
COR	Chittaurgarh Jn
CORD	Bilaspur Chord Cabin
CP	Chitpur
CPA	Kanpur Anwrganj
CPB	Kanpur Bge L Bk
CPBH	Chiraila
CPBN	New Chiraila Pauthu Jn
CPC	Kanpur Central Goods Shed
CPCS	Central Pit Colliery Sdg.
CPCT	Chennai Petroleum Corporation Ltd Gati-Shakti Multi Modal Cargo Termin
CPD	Chinchpada
CPDR	Chhipadohar
CPE	Chandiposi
CPFS	CONCOR Pft At New Swarupganj Served By New Swarupganj
CPH	Champa
CPHC	Chirmiri Colliery Siding
CPHT	Coopers Halt
CPIB	CONCOR of M/S. CONCOR
CPJ	Kaptanganj Jn
CPK	Chaparmukh Jn
CPL	Chakarlapalli
CPLE	Chinpai
CPM	Cholapuram
CPML	M/S Itc Limited
CPMR	Chapramari
CPMU	Central Pulp Mills Ltd Siding, Ukai Songadh
CPN	Champaner Road Jn
CPNL	Kanpur C Panel
CPP	Chipurupalle
CPPR	Champapur Halt
CPQ	Chaprakata
CPR	Chhapra
CPS	Chand Siau
CPSG	Ordinance Depot Sdg, Talegaon Dabhade
CPSN	Chhatrapati Sambhajinagar
CPT	Channapatna
CPU	Chopan
CPW	Chotipadoli
CPWD	Cpwd Siding, Dsj
CPWS	Crompton Greaves Ltd. SDG
CPYZ	Chipyana Buzurg
CQA	Cherukara
CQL	Chirakkal
CQR	Champapukur
CQS	Capper Quarry
CRA	Churulia
CRAE	Cheragram Bh.
CRC	Charkhari Road
CRCC	Chinchwad Container Depot
CRD	Currey Road
CRDA	Chakardaha Halt
CRE	Chorghatpipariya
CRFB	Chunch No 2 ( Reliance Fire Bricks Barakar & Pottary Sdg) Ba
CRG	Churaman Nagri
CRJ	Chittaranjan
CRK	Charkhera
CRKR	Chaurakheri
CRL	Choral
CRLM	Karmelaram
CRMM	Miraj Container Depot
CRMS	Military Siding, Chandari
CRN	Charegaon
CRND	Choranda Jn
CRNM	Mulund Depot
CROA	Chautara
CROP	Cherlopalli
CRP	Chandrapura
CRPD	Central Despatch Yard and Ore Tippler No.4 & 5 of M/S Rinl.
CRPM	Chandrampalem
CRQ	Charpokhari Halt
CRR	Karagola Road
CRS	Chourashi
CRTK	Turbhe Container Siding
CRU	Chudawa
CRV	Chureb
CRW	Charaud
CRWA	Chirawa
CRWL	Chakrakwala
CRX	Carron
CRY	Chirayinkeezh
CRZ	Caranzol
CS	Kannur South
CSA	Chausa
CSAS	SAIL Siding, Csdr
CSB	Shivaji Bridge
CSCL	M/S Calcutta Steel Company Ltd SDG Served By Sodepur
CSCP	Central Sonda Colliery Siding
CSDJ	Csd FCI Siding (P) (BG)
CSDR	Channasandra
CSDS	Sleeper Depor Rly Siding Clutter Buckgang
CSGJ	M/S. Chhattisgarh State Power Gen. Co. Ltd.
CSID	Mohan Siding Palachori
CSM	Cansaulim
CSMA	Chanasma Jn
CSMT	Mumbai CSMT
CSN	Chalisgaon Jn
CSPD	Csp Siding,dgg
CSPS	Central Screening Plant Colliery
CSR	Chak Sikandar
CSRP	CONCOR Siding At Rsd,raipur
CSRR	CONCOR Depot Siding Ravtha Road
CSSI	Civil Supplies (FCI) Assisted SDG Cossipore Road
CSTM	Chatrapati Shivaji Maharaj Terminus
CSTN	Sanatnagar CONCOR Siding
CSY	Cossye Halt
CSZ	Cossimbazar
CT	Chittapur
CTA	Chitradurg
CTC	Cuttack
CTCL	Cheviot Co. Ltd Budge Buidge
CTCS	CONCOR Terminal At Shalimar (kgp Div)
CTCT	CONCOR Terminal At Tatanagar (ckp Div)
CTD	Chhota Udepur
CTDI	Brownfield Pft of CONCOR Terminal Durgapur
CTF	Chitgidda
CTGN	Cotton Green
CTH	Chikalthan
CTHR	Chitahra
CTHT	Chatar Halt
CTJ	Chhataini
CTKR	CONCOR Terminal Kopt Coal Dock Road
CTKT	Chhoti Khatu
CTL	Chital
CTLI	Chatouli
CTM	Kattangulatur
CTMP	Chhit Makandpur
CTND	Chettinad
CTO	Chittoor
CTPE	Chandanattop Halt
CTPR	Chinta Parru Halt
CTPS	Chandrapur Thermal Power Stn SDG
CTQ	Chetar
CTR	Chatra
CTRD	Chitrawad
CTRE	Chitteri
CTRL	Chhatral
CTS	Chhatariput
CTT	Chitrasani
CTTP	Chitrapur (H)
CTU	Chhatapur Road
CTW	Chhintanwala
CTYL	Chityala
CTZ	Chauntra Bhater
CU	Chagallu
CUE	Choupale
CUK	Churk
CUKI	Churki
CUL	Chuli
CUPJ	Cuddalore Port Jn
CUR	Churu
CUX	Chaura
CV	Cauvery
CVB	Cavalry Barracks
CVD	Chavadipalaiyam
CVDS	Delhi Cantt Cvds Siding
CVJ	Chavaj
CVJB	Chavaj B
CVP	Kovilpatti
CVPS	Cauvery Public Siding
CVR	Chorvad Road
CVV	Cheruvu Madhwrm
CW	Chainwa
CWA	Chhindwara Jn
CWCB	Cwc (brownfield Pft)
CWCJ	M/S. Dp World Multimodal Logistics Pvt. Ltd-Jakhwada
CWCK	Cwc Siding
CWCN	Cwc Siding, Noli
CWDA	Cwda
CWHB	Cwc Siding
CWHC	Central Warehouse Sdg.
CWHN	M/S. Central Warehouseing Corporation
CWHS	Central Warehousing Corporation Siding Khandwa
CWI	Chondi
CWJC	Central Warehousing Corp. Siding
CWLE	Chowrigacha
CWN	Charawan
CWR	Chovvara
CWT	Chowhatta
CX	Chanol
CXA	Chandsara
CYD	Classification Yard, Waltair Marshalling Yard
CYI	Chhayapuri
CYN	Cheriyanad
CYR	Charni Road
CYZ	Chipyana Buzurg
D	Deula
DAA	Datia
DAB	Dharmabad
DABN	Dhaban
DAC	Dahinsara Jn
DACT	Dhaka Cantonment
DAD	Devargudda
DADN	Dr. Ambedkar Nagar
DAE	Dahegaon
DAG	Dhang
DAH	Dehare Cabin
DAJ	Daroji
DAKA	Dhaka
DAKD	Dekakund
DAKE	Dakhineswar
DAL	Daliganj Jn
DAM	Dhamora
DAN	Dhaneta
DANE	Danre
DAO	Daghora
DAP	Dagmagpur
DAPD	Dapodi
DAPN	New Dagmagpur
DAQ	Daud Khan
DAQN	New Daud Khan Jn
DAR	Danwar
DARA	Dara
DARI	Dhari Jn
DAS	Dhasa Jn
DASG	Dehu Ammunition Depot, Shelarwadi
DATR	Daitari
DAU	Dagru
DAV	Devalgaon Auchr
DAVC	Dav College (jalalab
DAVJ	D. A.v. C.h. Jalandher
DAVM	Dhanu Vacha Puram Ha
DAY	Dayadara
DAYG	Dariyaganj
DAZ	Delhi Azadpur
DB	Dabhoi Jn
DBA	Dabra
DBB	Dhubri
DBCP	Dalurbandh Colly. SDG
DBCS	Db Colliery Siding, Talcher
DBD	Deoband
DBDN	New Deoband
DBEC	Devbaloda Charoda P. H.
DBF	Dabpal
DBG	Darbhanga Jn
DBGBH	Darbhanga Bypass Halt
DBHL	Dobh Bhali Jn
DBI	Dabli Rathan
DBK	Darbari
DBKA	Dabka
DBL	Dodbele
DBLA	Dabla
DBLG	Dibolong
DBLI	Deora Bandhauli Halt
DBLN	New Dabla
DBM	Dabolim
DBN	Dhablan
DBNK	Derababa Nanak
DBNR	Dibnapur
DBO	Dabhoda
DBOU	Dabhou
DBP	Debipur
DBPR	Pvt. Sdg. of M/S. Db Power Limited/Rob
DBQ	Dhulabari
DBR	Dabhaura
DBRG	Dibrugarh
DBRI	Duburi
DBRT	Dibrugarh Town
DBS	Dobbspet
DBSC	Dayabasti Bypass A Cabin
DBSD	Dongri Buzurg SDG
DBSI	Dayabasti
DBT	Dakshin Barasat
DBTK	Dry Bulk Terminal-Tekra
DBU	Dodballapur
DBV	Dabilpur
DBW	Dubia
DBY	Digboi
DBYC	Dugda Line No.3 Box Yard Public Siding
DBZ	Dhing Bazar
DC	Magudanchavadi
DCA	Damchara
DCAB	Bhilai D Cabin
DCBD	D Cabin/Bmy
DCCK	Domestic Container Terminal CONCOR Served By Khodiyar
DCCS	Daulatabad CONCOR Siding
DCDG	Dedicated Freight Corridor Corporation of India Ltd.
DCH	Dinhatta Clge H
DCK	Dhandhuka
DCOP	Durgapur Coke Oven Plant Exchange Yard SDG Waria
DCP	Dal Chapra
DCPG	Diamond Cement Siding Paricha
DCSA	Shree Digvijay Cement Co Ltd Sikka
DCSD	Dumanhill Colliery Siding
DCSG	East Dongar Chikli Colliery Sdg.
DCSK	Dakra Manual Siding
DCSM	M/S ACC Limited
DCSN	Dudhichua Siding
DCTL	Dombivli Chord Cabin
DCU	Damalcheruvu
DCWS	Diessel Component Works Rly SDG Patiala
DCX	Dhanichha
DD	Daund Jn
DDA	Duraundha Jn
DDAC	Daund Jn A Cabin
DDAM	Daund A Cabin (Manmad)
DDAP	Daund A Cabin (Pune)
DDC	Dum Dum Cantt
DDCC	Daund Chord Line
DDCE	Dundi
DDCL	Domvivali Control Cabin
DDCW	Dugda Coal Washery SDG
DDD	Dhondha Dih
DDDA	Duddeda
DDDI	Dasar Doddi
DDDM	Deen Dayal Dham
DDE	Dondaicha
DDG	Digha Ghat
DDGA	Dugda
DDGJ	Deedar Ganj
DDGS	Dumdum Branch Gun Shell Fy. SDG Ddc.
DDHI	Doddahalli
DDIP	Deep Draught Iron Ore and Coal Berths of M/S Ppt
DDJ	Dum Dum
DDJA	Daund Goods Yard
DDK	Dhindsa
DDL	Dhandari Kalan
DDM	Dam Dim
DDMT	Darimeta
DDN	Dehradoon
DDNA	Dudhaunda
DDNI	Dudhnoi
DDP	Daudpur
DDPS	Deendayal Port Trust Terminal,shirva Rail Link Served By Shirva
DDQ	Dhandhuka City
DDR	Dadar
DDS	Dudh Sagar
DDSG	Diamond Cements Siding, Damoh
DDSN	Dda Siding
DDSP	Deep Draught Iron Ore and Coal Berths of M/S Ppt Phase-II
DDU	Pt. Deen Dayal Upadhyaya Jn
DDUN	New Pt. Deen Dayal Upadhyaya Jn
DDV	Dadhdevi
DDVC	Dvc Sdg. Dgr
DDW	Dudwa
DDWA	Deedwana
DDX	Dhamdhamia
DDY	Dudwindi
DDYX	Daund Jn Yard (Txr)
DDZ	Dadgaon
DEA	Diara
DEB	Debagram
DEBS	Delhi Cantt BG Military Siding
DEC	Delhi Cantt
DED	Dandeli
DEE	Delhi Sarai Rohilla
DEEG	Deeg
DEG	Delang
DEH	Diara
DEHR	Dehu Road
DEIA	Deoria
DEIT	Dehit
DEL	Denduluru
DELI	Deoli
DELO	Deorakot
DEMU	Demu
DEO	Deokali
DEOR	Diyodar
DEOS	Deoria Sadar
DEP	Depalsar
DEPI	Deenapatti
DER	Dadri
DERN	New Dadri
DES	Desari
DET	Det
DEU	Devsana
DEULA	DEULA Station
DEV	Devarayi
DEW	Dewalgaon
DEWA	Dewa
DFBD	Dedicated Freight Corridor Corporation of India Ltd
DFCI	FCI Sdg. Dgr
DFR	Deogan Road
DFSB	Dedicated Freight Corridor Corporation of India Ltd.
DFSD	Food Corpn. of India, Dankuni
DG	Dindigul Jn
DGA	Dighwara
DGB	Dindu G Puram H
DGBC	Dhamalgaon Block Cabin
DGBH	Digha Bridge Halt
DGBZ	Dongri Buzurg P. H.
DGCW	Durgapur Cement Works, Andal
DGD	Dangidhar
DGDG	Durgada Gate
DGF	Dhagaria
DGFJ	Dahej
DGG	Dongargarh
DGHA	Digha
DGHL	Dighal
DGHR	Deoghar
DGHT	Digha Ghat
DGI	Dungri
DGJ	Dungar Jn
DGLE	Dhulian Ganga
DGN	Dongargaon
DGNH	Dargaon Halt
DGNR	Durganagar
DGO	Durgauti
DGON	New Durgauti
DGPP	Dhengli Pp Goan
DGQ	Dugdol
DGR	Durgapur
DGRN	Dfccil Gati Shakti Multi-Modal Cargo Terminal At New Rewari
DGS	Dagori
DGSC	Dugda Line No.2 Public Siding
DGT	Dhulghat
DGTP	Dvc Thermal Pwr SDG Oyr
DGU	Digaru
DGW	Dhigawara
DGX	Dagaon
DGY	Dighori Buzurg P. H.
DGZ	Deviganj
DH	Diamond Harbour
DHA	Dheena
DHAE	Dainhat
DHAT	Dhat
DHBI	Dhabauli Halt
DHD	Dahod
DHE	Dobhi
DHG	Dhrangadhra
DHH	Dinhata
DHI	Dhule
DHJ	Dhinoj
DHK	Dhakuria
DHKR	Dhoda Khedi
DHL	Devanahalli
DHLI	Dethli
DHM	Dadhalinam
DHMA	Dhamarda
DHMZ	Dhola Mazra
DHN	Dhanbad Jn
DHNA	Dhachana
DHND	Dhinda
DHNE	Dhone Jn
DHNL	Dhanala
DHNR	Dhanora Deccan
DHO	Dhaulpur
DHOA	Dhaulpur
DHP	Dichpalli
DHPD	Dhapara Dham
DHPR	Dappar
DHPS	Bhatpara Power House Siding Kankinara
DHQ	Dharakhoh
DHR	Dharnaoda
DHRJ	Dhirganj
DHRN	Dhurana
DHRR	Dhirera
DHRY	Dhalpukhuri
DHS	Dhavalas
DHT	Dhamara Ghat
DHU	Dhubulia
DHVR	Dhanawars
DHW	Dhariwal
DHWN	Daniawan
DHWS	Dhosawas
DHY	Dharodi
DI	Dombivli
DIA	Didwana
DIB	Dibai
DIBL	Dholi (Bhal)
DIC	Dahisar
DICD	Inland Container Depot Dhandarikalan
DIE	Demai
DIG	Duggirala
DIGH	Digha Gaon
DIH	Dharuadihi
DIL	Dilawarnagar
DIM	Dhansimla
DING	Ding
DINR	Divine Nagar Halt (f
DIP	Dipore
DIPA	Dipa
DIQ	Dinagaon
DIR	Dhanapur Orissa
DISA	Disa
DIT	Dohrighat
DIU	Dhing
DIVA	Diva
DIW	Dhilwan
DIWR	Digwar Halt
DJ	Darjeeling
DJA	Daotuhaja
DJB	Dijaobradijaobra
DJD	Didarganj Road
DJF	Dhoraji (factory Siding)
DJG	Duliajan
DJHR	Deojhar
DJI	Dhoraji
DJKR	Dolaji ka Khera
DJL	Dodjala H
DJOS	Oil India Siding (P) (BG) Duliajan
DJPD	Dharmui-Jaghina Pol Sdg. Dum
DJR	Domjur
DJRZ	DJRZ Station
DJS	Dhurani Jwas Halt
DJSLS	Darjeeling Steam Loco Shed
DJX	Dungripadi
DK	Dakor
DKAE	Dankuni
DKB	Dakshin Bari
DKBJ	Dahar ka Balaji
DKC	Devarkadra
DKCH	Dakachya
DKD	Donakonda
DKDE	Dankaur
DKDP	Dakshin Durgapr
DKE	Dihakho
DKGN	Dekargaon
DKGS	Dinkar Gram Simaria
DKI	Dharmkundi
DKJ	Dornakal Jn
DKJB	DKJB Station
DKJR	Dhekiajuli Road
DKLG	Dhakalgaon
DKLU	Doikallu
DKM	Dikom
DKMN	Deoria Kurhma Naresh Halt
DKN	Devangonthi
DKNG	Devangonthi Lpg Siding
DKNS	Devangonthi Oil Siding
DKNT	Dakaniya Talav
DKO	Devakottai Road
DKPM	Dekapam
DKQ	Dhani Kasar
DKR	Dekpura Halt
DKRA	Dhuankheri
DKRD	Dockyard Road
DKS	Darekasa
DKSA	Draksharama
DKSK	Dumrikhurd SDG
DKT	Dhulkot
DKU	Dumri Khurd P. H.
DKUR	Dokur
DKW	Dhanakwada
DKWA	Dokwa
DKX	Dudhwakhara
DKY	Dhoki
DKZ	Delhi Kishan Ganj
DL	Daladi
DLA	Doulta
DLB	Daulatabad
DLBC	Durg Link Block Cabin
DLC	Dulmera
DLCR	Dullabcherra
DLD	Dalauda
DLDE	Daldali
DLF	Dalan
DLGN	Dhalgaon
DLGS	Duklangia
DLI	Delhi Jn
DLIB	M/S Distribution Logistics Infrastructure Pvt. Ltd.
DLJ	Dhola Jn
DLK	Dalkolha
DLLM	Diesel Loco Shed Ltt Mumbai
DLM	Daskalgram
DLMH	Dhaulimuhan
DLN	Dildarnagar Jn
DLO	Dalgaon
DLP	Dalpatpur
DLPC	Daulatpur Chauk
DLPH	Daulatpur Halt
DLPI	Delhi Indrapuri
DLPR	Dayalpur
DLPT	Dulakhapatna
DLQ	Dalelnagar
DLR	Dullahapur
DLSR	Dalhogi Road
DLSV	Diesel Loco Shed, Waltair Marshalling Yard
DLTR	Jamalpur Link Cabin
DLV	Dolavali
DLW	Dilwa
DLWS	Diesal Locomotive Works Rly SDG Varanasi
DLX	Dalimgaon
DLZ	Dholbaja
DM	Dimow
DMA	Damodar Jn
DMBR	Dumri Bihar (E)
DMC	Dhemaji
DMCA	Damaracherla
DMD	Dharmadam
DME	Damnagar
DMF	Dumerta
DMFS	FCI Siding Dimapur
DMG	Domingarh
DMGN	Dhamalgaon
DMGS	Damagoria Colly. SDG
DMH	Dauram Madhpura
DMJ	Dharmaj
DMJG	Dharamjaigarh
DMJR	Domjur Road
DMK	Dilmili
DML	Dharamtul
DMLE	Dumurdaha
DMLI	Damlai
DMM	Dharmavaram Jn
DMN	Dhamangaon
DMNJ	Daman Jodi
DMO	Damoh
DMP	Dharampur Himachal
DMPR	Dharampur
DMR	Dharmanagar
DMRS	Military Ramp Siding, Dhabalan
DMRT	Dumuriput
DMRX	Dumri
DMSA	Dhemo Main Colly. SDG
DMSG	Devlali Military Siding, Devlali
DMSJ	Daulatpur SDG & Mineral SDG , Jmp
DMSR	Dhimsiri
DMT	Diguvametta
DMU	Dhamua
DMV	Dimapur
DMW	Dalmau Jn
DMWP	Dmw Halt Patiala
DMYA	Damoy
DMZ	Dumdangi
DN	Dhanari
DNA	Degana Jn
DNCN	New Dagmagpur
DNCP	N S Dhori Colliery Siding
DNCS	Dhori Nsd Colliery Siding Phusro
DND	Dandupur
DNDI	Dhondi
DNDL	Dandi Mal
DNDP	Down Departure Yard Served By Mughalsarai
DNE	Dhamni
DNEA	Danea
DNGD	Dungarda
DNGI	Dangari
DNH	Deonagar
DNHK	Dhindhora Hkmkd
DNHL	Dhaniakhali Halt
DNI	Dansi
DNJ	Daundaj
DNK	Dhanakya
DNKL	Dhenkanal
DNL	Dhanoli P. H.
DNM	Dhanmandal
DNN	Dina Nagar
DNPR	Dhanpura
DNQ	Dandkhora
DNR	Danapur
DNRA	Dhandhera
DNRE	Dhanauri
DNRP	Dungarpur
DNSD	Dhori Nsd Colly. Siding,phusro, Line No. II
DNT	Dantan
DNU	Dalasanur Halt
DNUA	Dhansura
DNV	Donkinavalasa
DNW	Dangarwa
DNWA	Dangarwa
DNWH	Daniyawan Bzr H
DNWR	Dhanwar
DNX	Dhansu
DNZ	Dhanori
DO	Dausa Jn
DOA	Doraha
DOB	Dundlod Mukandgarh
DOBH	Deobahal
DOC	Daun Kalan
DOD	Dhodhar
DODH	Dodh
DOE	Deori
DOGL	Donigal
DOH	Dhodra Mohar
DOHM	Devgarh Madriya
DOI	Domohani
DOK	Dholka
DOKM	Dokra Halt
DOKN	New Dukheri
DOKY	Dukheri
DOL	Dholi
DOLK	Dholikua
DON	Derawan Halt
DOR	Dundara
DORD	Deo Road
DOS	Dehri on Sone
DOT	Dhakia Tiwari
DOTL	Deotala
DOW	Davol
DOX	Dohna
DOY	Dornahalli
DOZ	Daurai
DPA	Durgapura
DPC	Darliput
DPCB	M/S Dhamra Port Company Limited Siding
DPCS	Philips Carbon Black.(dib) Sbg Dgr
DPD	Dosapadu
DPDH	Dhanpatdih
DPDP	Dhapdhapi
DPE	Devarapalle
DPH	Dadhapara
DPI	Doddampatti
DPJ	Dharmapuri
DPK	Dholipal
DPL	Danauli Phlwria
DPLI	Dapoli
DPLN	Diplana
DPMT	M/S Dp World Multimodal Logisticshyderabadprivatelimited
DPNR	Deepnagar Halt
DPO	Damanpur
DPP	Dhirpur
DPR	Dhampur
DPRA	Dhupdhara
DPRT	Dattapahar Siding
DPS	Dangoaposi
DPSB	New Bhadan
DPSC	Dugda Line No.5 Public Siding
DPSR	Dapsaura
DPT	Dalpat Singhpur
DPU	Diphu
DPUR	Depur PH
DPW	Dhapewara
DPX	Dadpur
DPZ	Devpura
DQG	Dhupguri
DQL	Dhalaibil
DQN	Dhanera
DQR	Dabirpura
DQV	Daula Kot Bhai
DR	Dadar
DRA	Dularia
DRB	Debari
DRBR	Deoraha Baba Road
DRD	Dahanu Road
DRDG	Daridag
DRE	Dhogri
DRG	Darshannagar
DRGI	Dronagiri
DRGJ	Daraganj
DRGM	Deoragram
DRGU	Damrughutu
DRH	Dharhara
DRHI	Dagar Khedi
DRHN	New Dharuhera
DRI	Dumri Juara
DRL	Derol
DRLA	Daurala
DRLN	New Daurala
DRMT	Dhrumath
DRN	Deoranian
DRO	Daryaogonj
DRPH	Devri P. H.
DRQ	Dharminiya
DRR	Dharur
DRRN	Dr. Rk Nagar
DRS	Dhareshwar
DRSN	Dhurwasin
DRSV	Dharashiv
DRTA	Dronagiri Rail Terminal
DRTP	Dasharathpur
DRU	Kadur
DRV	Darauli
DRW	Dharewada
DRWN	Derowan
DRZ	Dalli Rajhara
DS	Dasna
DSA	Delhi Shahdara
DSAP	Delhi Shahdara A Pan
DSB	Sadar Bazar
DSBC	Delhi Shahdara Block
DSBF	Falakata Siding (P) (BG)
DSBG	Defence Yard Siding , Babina
DSBP	Delhi Shahdara B Panel
DSD	Dosvada
DSEY	Durgapur Steel Exchange Yard SDG Andal
DSGD	Dasua Defence Military Siding
DSGF	Fatehgarh Churian Defence Siding
DSGR	Deepika Siding of SECL
DSHI	Doddasiddavanhalli Halt
DSJ	Delhi Safdarjung
DSK	Duskheda
DSKG	Dr. Srikrishna Singh Nagar Garhpura
DSKP	Dskp Rly Sdg, Kathua
DSL	Deswal
DSLD	Dcm Shriram Limited Siding Served By Dadhdevi
DSLP	Deshalpar
DSM	Darasuram
DSMD	Dhampur Sugar Mills Siding
DSME	Dasara
DSN	Darsana
DSNI	Dausni
DSNR	Dashnagar
DSNS	Dudhichua Silo # 03 GCT of NCL
DSO	Deshnok
DSPL	Daspalla
DSPN	Deshpran PH
DSPR	Dhansiripar
DSPT	Danishpet
DSR	Dhansiri
DSRD	Desar Road
DSRP	Raipur Diesel Loco Shed
DSS	Dalsingh Sarai
DST	Dasampatti
DSTP	M/S Durgapur Steel Thermal Power Station
DSVS	D. Samudravalli
DSWD	Daurala Sugar Works Siding
DSX	Desang
DTAE	Dhatrigram
DTAP	Dhatura Alipur P. H.
DTBR	Dhamra Terminal Yard
DTC	Ditokcherra
DTCC	Dativli Chord Cabin
DTCP	Dobari No. 2 Colliery Siding, Patherdih
DTD	Dasalwada-Antroli Road
DTE	Deulti
DTF	Dantla
DTG	Dignagar
DTJ	Detroj
DTK	Dattapukur
DTL	Darritola
DTN	Dhamtan Sahib
DTO	Daltonganj
DTP	Divitipalli
DTQ	Datarda Kalan
DTR	Dhamtari
DTRA	Dantra
DTRD	Diyatraroad
DTT	Dodaanatta Halt
DTV	Dhutra
DTVL	Dativali Cabin
DTW	Datewas
DTX	Dangtal
DU	Dhrub
DUA	Dhaura
DUAN	Duan
DUB	Dabtara
DUBH	Dubaha
DUD	Dudhani
DUE	Dudahi
DUGA	Dugga
DUGD	Dugda Coal Washery
DUH	Dudda Halt
DUI	Dhuri Jn
DUJ	Dubrajpur
DUK	Dudia
DULP	Daulatpur Hryna
DUM	Dhaurmui Jaghna
DUMK	Dumka
DUMR	Dumra
DUN	Duganpur
DUO	Dhaursalar
DUP	Dhulipalla Halt
DUQ	Dukhnawaran
DUR	Desur
DURE	Dumraon
DURG	Durg
DURP	Durgapuri
DUS	Dulrasar
DUSI	Dusi
DUT	Dum Duma Town
DUTR	Duriatanr Haly
DUU	Dupadu
DUV	Dungapur Quarry
DUY	Dumiyani
DV	Dhuva
DVA	Delvada
DVBH	Makudan Virapandi Block Hut
DVBR	Dvc SDG Brr
DVD	Duvvada
DVG	Davangere
DVGM	Devgam
DVH	Devi Halt
DVJ	Dilli Dewan Ganj
DVL	Devlali
DVM	Dalbhumgarh
DVN	Devthana
DVR	Doravarichattram
DVRD	Devalia Road
DVY	Devaliya
DWA	Dailwara
DWD	Dhekvad
DWDI	Dighwa Dubauli
DWF	Dudh Sagar Water Falls
DWG	Dewanganj
DWI	Dingwahi
DWJ	Dwarkaganj
DWJN	Diva Jn Cabin
DWK	Dwarka
DWL	Dhuwala
DWLE	Dhauni
DWLP	Dp World Rail Logistics Private Limited (Dwlp)
DWM	Darwha Moti Bagh Jn
DWNA	Diwana
DWO	Doiwala
DWP	Dwarapudi
DWR	Dharwar
DWT	Dewan Hat
DWV	Diwankhavati
DWWS	Dudhichua Wharfwall SDG
DWX	Dewas
DWZ	Dante Wara
DXD	Digod
DXG	Dharangaon
DXH	Duhai
DXK	Dhana Kherli
DXN	Duddhinagar
DXR	Digsar
DXU	Duhru
DY	Dumariya
DYD	Daryabad
DYDY	Departure Yard, Waltair Marshalling Yard
DYE	Dayanand Nagar
DYK	Dudhiyakhurd
DYP	Daryapur
DYS	Dalapathy Samudram
DYSG	Defence Yard Siding , Jhansi
DYU	Diyuri
DYW	Diyawan Halt
DZA	Dasuya
DZB	Dahina Zainabad
DZK	Durgachak
DZKT	Durga Chak Town
DZL	Dhana Ladanpur
DZP	Darazpur
DZPN	New Darazpur
EC09	Champapur Halt
EC14	Block Hut B
EC28	Pura Halt
EC31	Kharuara Halt
EC32	Imli Bigha Halt
ECAB	E Cabin, Waltair Marshalling Yard
ECCN	East Central Cabin Lucknow
ECRG	M/S. Electrosteel Castings Ltd Siding.,served By Rcg Rly Stn
ECYS	Cochin Shipyard Siding, Chts
ED	Erode Jn
EDA	Itwan Dundaila
EDCB	Exit Point From M/S Dhamra Port Company Ltd Via Bhc
EDD	Edduladoddi
EDDN	New Erc Pt. Deen Dayal Upadhyay Jn
EDG	Eden Gardens
EDN	Edamann
EDP	Edapalayam
EDPB	Entry Point To M/S Dhamra Port Company Ltd Via Bhc
EDPR	Entry Point To M/S Dhamra Port Company Ltd Via Rljc
EDRC	Exit Point From M/S Dhamra Port Company Ltd Via Rljc
EDU	Eriodu
EE	Eluru
EGPR	Galvanised Plant Engg Sdg,rsd
EGT	Egattur
EGU	Iranagallu
EIML	East India Mineral Ltd. Siding
EKC	Ekchari
EKH	Eksari Halt
EKI	Eklakhi
EKL	Ekdil
EKLN	New Ekdil
EKM	Ekambarakuppam
EKMA	Ekma
EKN	Ezhukone
EKNR	Ekta Nagar (Kevadiya)
EKR	Ekangarsarai
EL	Elamanur
ELDD	Electric Loco Shed - Daund
ELL	Eraligu
ELM	Elimala
ELP	Achalpur
ELR	Elavur
ELRA	Adani Agri Logistics Ltd Pvt Siding, Elavur
ELRF	Faridkot Military Siding
ELRK	Kotkapura Military Siding
ELRS	Electro Steel Casting Ltd Siding
ELSV	Electrical Loco Shed, Waltair Marshalling Yard
EMIJ	Pvt Siding of M/S Odisha Mining Corporation Limited (Omcl)
EMTY	Empty Yard, Vsps
EN	Isand
ENB	Ellenabad
ENBG	Isand BG
ENF	Ennore Port Ltd Sdg, Attipattu
ENR	Ennore
ENTS	Tneb Ennore Thermal Siding, Ennore
EOC	Udl East Outer Cabin
EOCM	Eocm Cabin
EOLD	M/S Nayara Energy Ltd
EPAB	Entry Point To Asrl From Budhapank Via Route 'a'
EPBB	Entry Point To Asrl From Budhapank Via Route 'c'
EPBL	Entry Point To Asrl From Baghuapal
EPCP	Entry Point To Hprcl From Paradip
EPHH	Entry Point To Hprcl From Haridaspur
EPHI	Eph Siding Rajghat
EPHN	Eph Siding Indraprastha
EPHY	Epl Holding Yard II
EPMA	Entry Point To Mcrl From Angul
EPMK	Entry Point To Mcrl From Kerejanga
EPMM	Entry Point To Mcrl From Balaram Siding
EPR	Mumbai (elphinstone Road)
EPTA	Entry Point To Asrl From Tomka Via Route 'd'
ERC	Erich Road
ERCB	East Receiving Cabin Served By Mughalsarai
ERL	Eraniel
ERM	Ernakulam Marshalling Yard
ERN	Ernakulam Town
ERNF	The Fertilizers and Chemicals Travancore Siding, Ipn
ERNS	Cochin Refineries Broad Gauge Siding (pol & Lpg), Ipn
ERS	Ernakulam Jn
ERSC	Ernakulam C Cabin
ERSD	Ernakulam D Cabin
ESCL	M/S Electro Steel Castings Ltd SDG Sodepur
ESDS	ER Store Depot Naihati
ESGB	M/S Esl Steel Limited Gatishakti Multimodal Cargo Terminal At Bandhdih
ESGP	Gorakhpur Ac Electric Loco Shed
ESSB	Vidut Loco Shed Saiyedpur Bhitri
ESSG	Enginering Store Transit Depot, Shelarwadi
ESV	Isivi
ET	Itarsi Jn
ETAH	Etah
ETB	Itarsi B Cabin
ETBC	Itarsi B Cabin
ETF	Itarsi F Cabin
ETK	Etakkot
ETM	Ettumanur
ETMD	Ettimadai
ETP	Ettapur Road
ETPS	Etp Siding, Sujanpur
ETR	Elattur
ETUE	Etmadpur Jn
ETW	Etawah Jn
ETYD	Empty Yard ( Andal )
EVA	Edavai
EWMD	Egerton Woolen Mills Siding
EZP	Ezhuppunna
FA	Falna
FAB	Fatehabad
FAH	Fateha Halt
FAN	Fatehnagar
FAP	Fakharpur Halt
FAR	Farah
FBD	Farrukhabad
FBG	Forbesganj Jn
FBPS	Farakka Barrage Project SDG ., Tildanga
FBSG	Food Corp. of India SDG
FBWG	Flush Butt Welding Point
FBWP	Flashbutt Welding Plant
FBWS	M/S Flash Butt Welding Sdg, Jharsugudha Jn
FCA	Food Corporation of India Siding Ramnagar
FCAB	F Cabin, Waltair Marshalling Yard
FCAP	FCI Siding (pvt/Bg), Archipathar
FCB	FCI SDG Bsp
FCBG	Food Corporation of India, Nuzividu
FCBK	FCI Siding (Pvt) Bindukuri
FCC	Food Corpn of India Siding
FCD	FCI Sdg, Dhanbad
FCDB	FCI Siding, Dec
FCDG	FCI Siding Dighaghat
FCE	FCI Siding
FCG	FCI Siding Ghevra
FCGC	M/S Fci, Gati Sakti Multi-Model Cargo Terminal At Cinnamara
FCGD	FCI Siding-Godhra
FCGM	FCI Siding - Gandhidham
FCGR	FCI Siding, Gurdaspur
FCGS	Food Corporation of India, Krishna Canal
FCGV	Food Corporation of India, Gudivada
FCIB	FCI Siding
FCIC	Food Corporation of India, Charlapalli
FCID	FCI Siding, Dhuri
FCIE	Food Corporation of India (P) (BG)
FCIG	FCI Siding Gnanapuram, Vpt
FCIJ	Food Corporation of India, Jmkt
FCIK	Food Corporation of India Khammam
FCIM	Food Corporation of India, Miryalguda
FCIP	Food Corporation of India
FCIR	Food Corporation of India, Rajamundry
FCIT	Food Corporation of India, Venkatachalam
FCIV	FCI Siding Kandivili
FCIZ	Food Corporation of India, Zangalapalle
FCK	FCI (Pvt) SDG Kalyani
FCKR	FCI Siding Kur
FCKS	Fact Sdg, Kalamasseri
FCMA	FCI Siding, Moga
FCMB	Food Corpn of Lndia Masonry Grain Godown Siding (bg), Chts
FCMH	FCI Siding Mandir Hasud
FCMI	FCI Siding Mokama
FCON	Container Siding Fatuha
FCOP	Food Corporation of India Sdg, Pilamedu
FCP	FCI Siding
FCPA	Food Corporation of India, Pennada Agraharam
FCPB	Food Corooration of India Prefabricated, Chts
FCPD	FCI Pvt Siding Phulwari Sharif
FCPP	FCI Siding
FCSA	Food Corporation of India Sdg,avadi
FCSC	FCI Siding . Kanpur (Chandari)
FCSD	Food Corporation of India Siding, Sirsa
FCSH	FCI Siding, Hapur
FCSJ	FCI Siding, Jammutawi
FCSK	FCI Siding, Kkp
FCSM	FCI Siding Swm
FCSN	FCI Siding
FCSP	FCI Siding Patiala
FCSS	FCI Siding, Fcss
FCST	Food Corporation of India, Samalkot
FDB	Faridabad
FDBN	New Faridabad
FDBR	Fertiliser Handling Siding of M/S Dpcl
FDK	Faridkot
FDM	FCI Siding Dhamora
FDN	Faridabad Nw Tn
FDSG	Special Railway Siding, Faridabad
FFSB	FCI Siding Buxar
FFSG	Filling Factory Siding, Bhandak
FGCN	Fetehgarh Churn
FGDA	Adani Agri Logistics Ltd Dagru
FGH	Fatehgarh Hryna
FGR	Fatehgarh
FGSB	Fatehgarh Sahib
FGSG	Foodcorporationofindia,sidingagra
FGTP	Feroz Gandhi Thermal Project Siding
FHT	Farah Town
FIH	FCI Siding Hubli
FIK	Food Corpn of India Siding
FISG	Food Corporation of India Siding Et
FISS	FCI Siding (mg)-Sabarmati
FK	Ferok
FKA	Fazilka
FKB	Fakhrabad
FKG	Furkating Jn
FKM	Fakiragram Jn
FKSG	Food Corporation of India, Kzj
FKZS	FCI Sdg, Kazhakuttam
FL	Phulera
FLCK	Fazalchak
FLD	Phulad
FLK	Falakata
FLM	Falimari
FLN	New Phulera Jn Station
FLR	Fuleswar
FLU	Phulia
FLY	Fomento Mining Ltd
FM	Falaknuma
FMP	Ferro Manganese Siding (Facor)
FN	Farukhnagar
FNB	Fatehnagar Bridge
FNG	Faridnagar
FNHL	Fernhill
FNO	Fango
FNSG	Food Corporation of India Sdg, Nagpur (Ajni)
FOCM	Flyover Cabin Mughal Sarai
FOCS	Fly Over Cabin Sonenagar
FOS	Kiruburu New Bunkar of M/S. SAIL
FPAW	Fatehpur Atwa Halt
FPMP	Fatehpur Makrandpur
FPS	Fatehpur-Shekhawati
FPSG	Fertiliser Plant
FPY	Finished Product Yard, Vsps
FQBS	Fudkipur Quarry SDG . , Bakudi
FRD	Farhedi
FRDH	Faridaha
FRG	Farangipete
FRGD	Fair Ground P. H.
FRH	Farhatnagar
FRN	Fareni
FRTK	Fartikui
FSG	Phursungi
FSH	Food Grain Siding (A) (BG)
FSL	Food Specialities
FSNG	FCI Siding (P) (BG) New Guwahati
FSP	Fateh Singhpura
FSR	Faqarsar
FSTP	Farakka Super Thermal Power Project SDG Tdle
FSW	Fateh Singhwala
FTC	Fatehpur Chursi
FTD	Fatehabad Ch. Jn
FTG	Fursatganj
FTH	Fatuhi
FTP	Fatehpur
FTS	Fatehpur Sikri
FUT	Fatuha
FYZ	Faizullapur
FZD	Firozabad
FZGH	Ferozguda
FZL	Fazalpur
FZP	Firozpur City
FZR	Firozpur Cantt
FZSG	Rashtriya Chemicals, and Fertilizers Siding-Trombay
G	Gondia Jn
G1	G1 Station
GA	Gudha
GAA	Galan
GACL	Ambuja Cement Siding
GAD	Gevra Road
GADH	Goaldih
GADJ	Gandhinagar Jaipur
GADM	Ganga Dham
GAE	Gaipura
GAG	Gangaghat
GAGA	Galgalia
GAH	Gawnaha
GAHT	Ghusia Halt
GAI	Gauchhari
GAJ	Ganeshganj
GAJB	Gajara Bahara
GAJU	Gaju Halt
GAL	Ghatla
GALA	Gunadala
GALE	Gankar
GALF	Galfarbari SDG Barakar
GAM	Ganjam
GAMI	Gogameri
GAMN	Gamani
GANG	Gangaganj
GANI	Gharni
GANL	Ghanauli
GAO	Gaigaon
GAP	Gurpa
GAQ	Ganj Khawaja
GAQN	New Ganj Khwaja Jn
GAR	Gadarwara
GARA	Garha
GATD	Gautamdhara
GATL	Ghatoli
GAUR	Gaur
GAV	Gavadaka
GAVN	Gavhan
GAW	Gainjahwa
GAX	Gaganaposh
GAYA	Gaya Jn
GB	Gauri Bazar
GBA	Garbeta
GBB	Gubbi
GBD	Gauribidanur
GBE	Gayabari
GBG	Gobardanga
GBGG	Gajara Bahara Goods Shed
GBHA	Garobigha Halt
GBK	Gopalpur Balkda
GBN	Garh Banaili
GBP	Gulabpura
GBPM	Garhi Beri
GBQ	Godbhaga
GBRA	Gobra
GBRI	Gobarwahi
GBRS	Gobarsanda Halt
GBSS	M/S Sita Saongi Siding
GBX	Govindpur Road
GBY	Guabari
GC	Ghat Kopar
GCAB	Bmy G Cabin
GCC	Godhani Chord Cabin
GCCJ	GCT of M/S CONCOR At Jjkr
GCCK	Gati Shakti Cargo Terminal of Container Corporation of India Ltd
GCCN	Gurla C Cabin
GCCP	GCT of M/S. CONCOR
GCH	Gachhipura
GCN	Gocharan
GCNM	Gorbi Block-B Chp NCL SDG
GCSP	Giddi'a' Colliery Siding Patratu
GCT	Ghazipur City
GCWP	Giddi A Colliery Siding
GCWS	Gagal Cement Works
GD	Gonda Jn
GDA	Godhra Jn
GDB	Giddarbaha
GDBR	Goonda (Bihar)
GDCR	Gadchandur
GDD	Gadra Road
GDE	Garladinne
GDF	Gonudham Halt
GDG	Gadag Jn
GDGB	Gadag Bypass
GDGH	Gateway Rail Freight Ltd Pft (B/F)
GDGN	Gaudgaon
GDGS	Gandhidham Goods Shed
GDH	Gidnahalli
GDHA	Godha
GDI	Gudgeri
GDJ	Gunda Road Jn
GDK	Gonda Kachahri
GDKP	Ghundankhapa
GDL	Gondal
GDLG	Govt. Diesel Loco Maintenance Depot Gandhidham Served By Gandhidham
GDM	Gudma
GDMY	Gandhidham Marshalling Yard
GDN	Gangaikondan
GDNL	GCT To Serve Darlipali Super Thermal Power Project of M/S NTPC Ltd
GDO	Goverdhan
GDP	Gudupulli
GDPL	Gundla Pochampalli
GDPT	Gudaparti
GDPY	Gandhidham Passenger Yard
GDQ	Godamgura
GDR	Gudur Jn
GDRA	Gangadhara
GDS	Giddapahar Siding
GDSB	Gandhidham Diesel Shed
GDSG	Food Corporation Siding Manmad
GDU	Gudru Halt
GDV	Gudivada Jn
GDW	Gadhwala
GDWR	Garudeshwar
GDX	Ghoksadanga
GDY	Guindy
GDYA	Ghoradongri
GDYT	Goods Departure Yard At Tatanagar
GDZ	Gundardehi
GE	Goel
GEA	Ghatera
GEB	Garh Baruari
GEBL	Gorebal
GEBS	Dhuvaran Power House Siding (gujrat Elect. Bd) -Kathana
GED	Guledagudda Road
GEDE	Gede
GEG	Gir Gadhara
GEK	Gegal Akhri
GELA	Ghadela Halt
GEOR	Gunjaria
GER	Geratpur
GES	Gujarat Electricity Board Siding - Sikka
GETS	Guiarat Electricity Board At Pethapur Siding (BG)
GFAE	Garifa
GFCJ	M/S CONCOR At Jharsuguda
GFMK	Green Field Pft of M/S Lingaraj Translogistics Private Limited
GFPA	M/S. Punjab Logistics Infrastructure Ltd.
GG	Gandhigram
GGA	Ghoga
GGAR	Gangadhra
GGB	Garhmuktesar Br
GGC	Gangapur City Jn
GGD	Gullaguda
GGDA	Gharghoda
GGG	Gangagarh Halt
GGGS	Garha Goods Shed
GGH	Ghogardiha
GGJ	Goshainganj
GGKR	Govindgarh Khkr
GGLE	Gangatikuri
GGM	Gora Ghuma
GGN	Gurgaon
GGNP	Ganganapalle
GGO	Goram Ghat
GGP	Gangnapur
GGPP	M/S Gourideep Open Cast Mines
GGR	Gangrar
GGS	Ghugus
GGSG	Food Corporation of India Nishatpura
GGST	Garha Goods Shed - 2
GGSY	Ganga Sahai Halt
GGT	Ghunghuti
GGTA	Ghoraghata
GGV	Ghovarash Ghona
GGVT	Gangavathi
GGWA	Gangwara Halt
GGWT	Govindgarh (white Tiger)
GGY	Gagariya
GH	Ghughuli
GHA	Golehwala
GHAA	Ghaghra
GHAI	Ghatigaon
GHB	Gahri Bhagi
GHCL	Ghusick Colliery SDG
GHD	Garwa Road Jn
GHDA	Gholabagda
GHE	Ghevra
GHER	Gher
GHG	Ghagghar
GHGL	Ghagwal
GHH	Garhi Harsaru
GHI	Gambhirpura
GHJ	Gursahaiganj
GHL	Golhalli
GHLE	Gadadharpur
GHLU	Ghallu
GHN	Ghorparan
GHNA	Gohana
GHNH	Ghantikhal Ndpr
GHPU	Gandhipuram Halt
GHQ	Garhwa
GHR	Gidhaur
GHRI	Ghori Halt
GHS	Guru Harsahai
GHSG	Food Corporation Siding Pune
GHSR	Ghasara Halt
GHT	Ghaghara Ghat
GHTI	Ghantoli (Flag)
GHTL	Ggtpp Siding
GHUM	Ghum
GHX	Garhara
GHY	Guwahati
GHZ	Garhara Goods Marshalling Yard
GI	Guduvancheri
GIA	Garia
GIBP	Ghogi Bariarpur
GICK	Govinda Incline Colliery
GID	Giddalur
GIF	Gani Dham Halt
GIG	Gohrigaon Halt
GIHT	Gaighat Halt
GII	Gidhni
GIL	Gaisal
GILA	Ghiala
GILL	Gill
GIMB	Gandhidham BG
GIMC	Gandhidham Cabin
GIMI	ICD Container Depot Gim
GIMR	Gandhidham Rmc Loading Point
GIMY	Gandhidham Yard
GIN	Ginigera
GIO	Goriyan
GIR	Gainsari Jn
GIS	Garhi Sandra
GISG	Gray Iron Foundry Siding
GISL	General Industries Societies Ltd . Bhadreshwar Ghat
GISN	Grasim Industries Ltd Siding, Nagda
GIT	Ghorpuri Tranship
GIW	Girdharpur
GIZ	Gidam
GJ	Gangajhari
GJAB	Greenfield Pft of Jind Agri Services Private Limited
GJB	M/S Ganges Jute Mills SDG Bansberia
GJCW	Ghusick West Colliery SDG
GJD	Gujhandi
GJH	Goldinganj
GJJ	Gajjelakonda
GJL	Gajraula Jn
GJMB	Ganjmuradabad
GJN	Gajner
GJPD	Gop Jam Public SDG Digo, Gop (Jam)
GJR	Gojhariya
GJS	Gajsinghpur
GJT	Jannagatta Halt
GJTA	Gurudijhatia
GJUT	Gangsar Jaitu
GJW	Gajuwala
GJWL	Gajwel
GK	Gk
GKA	Gokhula
GKB	Ghataka Varana
GKC	Gorakhpur Cantt
GKD	Gadhakda
GKG	Gokalgarh
GKH	Guskara
GKHT	Gram Kharika Halt
GKJ	Golakganj Jn
GKK	Gokak Road
GKL	Gokulpur
GKM	Gundalukamma
GKP	Gorakhpur Jn
GKPE	Gorakhpur East Lobby
GKPI	Gate Karepalli
GKT	Gankhera Halt
GKV	Gootihalli
GKX	Ghai Kalan
GLA	Garla
GLBA	Golabai
GLBN	Gujran Balwa
GLD	Ghelda
GLE	Gajulaguden
GLG	Gulabhganj
GLGT	Golaghat
GLH	Gulaothi
GLHN	New Gulaothi
GLI	Galsi
GLKN	Gugalwa Kirtan
GLMA	Gulma
GLNA	Gulana
GLP	Gollaprolu
GLPT	Goalpara Town
GLTA	Gehlota
GLU	Gullipadu
GLV	Gulvanchi
GLY	Gollapalli
GM	Garmadi
GMA	Gudimetta
GMAN	Gumani
GMC	Kanpur Goods Marshalling Yard
GMD	Guramkhedi
GMDA	Gumada
GMDN	Girimaidan
GMDP	Gramdadpur
GME	Gumandev
GMG	Gumgaon
GMGM	Gomangalam
GMH	Gamharia
GMI	Gond Umri
GMIA	Gumia
GMK	Gulma Khola
GMM	Gumman
GMMG	Masagram Jn
GMN	Goregaon
GMO	Nsc Bose J Gomo
GMR	Gahmar
GMS	Garhmuktesar
GMTO	Gumto
GMU	Gauriyamau
GMUV	FCI Siding Manduadih
GMX	Gurmura
GN	Gopal Nagar
GNA	Goneana
GNB	Jnana Bharati Halt
GNBA	Gaon Baroda
GNC	Gandhinagar Capital
GNCK	Gati Shakti Cargo Terminal (Gsct) of M/S Ncml Chhehreatta Pvt. Ltd.
GNCN	Gurla N Cabin
GND	Govindgarh Malikpur
GNDI	Gondwali
GNDM	Bahuara Halt
GNG	Gauriganj
GNGD	Gangadharpur
GNGL	Gangauli
GNGR	Ghungrana
GNGT	Gangatola
GNH	Gangakher
GNHI	Gandhi Halt
GNI	Gourandi
GNJ	Gunji
GNJB	Gopinathjew Banikunda PH
GNJP	Gokulnagar Joypur
GNK	Garhnokha
GNL	Gongle
GNN	Gangineni
GNNA	Ganganiyan
GNND	Jnandas Kandra
GNO	Goregaon Road
GNP	Ghanpur
GNPR	Gunupur
GNPT	Ganpatpura
GNQ	Godhani
GNR	Gadiganuru
GNRD	Genoli Road
GNRL	Gangraul Halt
GNS	Ghonsor
GNSL	Ghansoli
GNST	Gandhi Smriti
GNT	Guntur Jn
GNTB	Gn Tp Siding
GNTR	Gauntra Halt
GNU	Ganaur
GNV	Gandevi
GNVR	Gondwanavisapur
GNVS	M/S Gujarat Narmada Valley Fert.& Chem. Ltd.gnfc Siding
GNW	Gangiwara
GNWA	Ghunwara
GNZ	Gahndran
GO	Ghoti
GOA	Gohad Road
GOC	Ponmalai
GOCB	High Pressure Boiler Plant Broad Gauge S
GOCW	Ponmalai Workshop
GOD	Gidarpindi
GODA	Godda
GOE	Ghograpar
GOF	Ghutiari Sharif
GOG	Ghorghat
GOGH	Gossaigaon Hat
GOGT	Goghat
GOH	Garot
GOI	Gevrai
GOK	Gokarna Road
GOL	Goilkera
GOLE	Gole
GOM	Gogamukh
GOMS	Nhpc Siding MG (Gom)
GOP	Gop Jam
GOPA	Ghosipura
GOPG	Gopalganj
GOR	Gopinathpur
GOS	Ghosrana
GOSG	Godahavari Khani No. 1 Colliery
GOT	Got
GOTD	Gorintada Halt
GOTN	Gotan
GOVR	Govindnagar
GOX	Gobindpur Dugli
GOY	Govindpuri
GOY2	Govindpuri 2
GOZ	Golsar
GP	Raj Gangpur
GPAE	Guptipara
GPB	Ghatprabha
GPBN	Gandhi Park Halt
GPC	Ghatpindrai
GPCK	Gevera Project Junadih Colliery-I
GPD	Gummidipundi
GPDE	Gudipudi
GPE	Gogipothia Halt
GPH	Garpos
GPHK	M/S. Hind Terminal Pvt. Ltd.
GPI	Gajapatinagaram
GPIM	M/S. Godawari Power and Ispat Limited
GPJ	Gorapur
GPLC	Private Siding of M/S Gopalpur Ports Limited
GPLG	Gopalpurgram
GPMA	Gop Mota
GPNB	Gopinathpur Nilgiri
GPPR	Gopalpur
GPR	Ghorpuri
GPRW	Ghorpuri West
GPS	Gojpur Sankheda
GPSA	Ghatparsia Halt
GPSD	Gravel Public Siding
GPSL	Gokulpur Saboli Halt
GPT	Gopala Patnam
GPTH	M/S Nuppl- Ghatampur Thermal Power Plant
GPU	Gulapalyamu
GPW	Ghaunspur
GPX	Gautampura Road
GPY	Gangayapalle
GPZ	Gohpur
GQD	Gourdaha (Halt)
GQL	Gurla Jn
GQLW	GQLW Station
GQN	Garhani
GR	Gulbarga
GRA	Gharaunda
GRAE	Gurap
GRAK	Garkha
GRB	Garh Dhrubbeswar
GRBH	Garea Bihar
GRBL	Garudubilli
GRCP	G Ramchandrapur PH
GRD	Giridih
GRE	Gola Road
GRF	Gambhiri Road
GRFB	Gambhir Bridge Cabin
GRFV	M/S Gateway Rail Freight Limited Served By Viramgam
GRG	Guwarighat
GRH	Ghorasahan
GRHI	Garhi
GRHM	Gir Hadmatiya
GRHX	Garra
GRI	Guriya
GRJ	Gatra Halt
GRJA	Gorinja
GRKA	Gurha Kemla
GRKN	Gorakhnath
GRL	Goraul
GRLC	Garhwa Road Link Cabin
GRM	Garhmau
GRMA	Ghormara
GRMP	Ganga Rampur
GRMR	Garhi Manikpur
GRMT	Gur Market
GRN	Gurnay
GRNA	Gurhanwa
GRO	Gurra
GRP	Gangpur
GRPA	Garhpura
GRPB	Gujarat Refinery Project Sdg, Bajwa
GRR	Gorphar
GRRG	Gurli Ramgarhwa
GRRK	Gareria Public Siding
GRRU	Guraru
GRS	Gurusar Sutlani
GRSK	Gujrat Refinery SDG (karchiya Yard),
GRTA	Goratiya
GRU	Garopara
GRV	Gohlwar Varpal
GRWD	Ghorawadi
GRX	Gaura
GRY	Goraya
GRZ	Gurthuri
GS	Godhaneshwar
GSA	Guagachha
GSAM	Gold Star Alloy Es Ltd. Mallividu
GSB	Garna Sahib
GSBR	Gurpahar SDG of Bsl, Birmitrapur
GSD	Ghosunda
GSDD	Dumka 2nd Dd Line
GSDH	Garsanda Halt
GSFM	Gujrat State Fertilizerco,l Siding
GSFS	Gujarat State Fertilizers Co Ltd-Bajwa
GSG	Ghugus Coilliery Sdg.
GSGB	Gosaingram
GSGJ	Ghausganj
GSI	Ghosi
GSK	Ghusia Kalan Halt
GSL	Godapeasal
GSO	Ghaso
GSP	Gurdaspur
GSPR	Gosalpur
GSPU	Gauspur Halt
GSQ	Guir Saranga
GSR	Garhshankar
GSRM	Gauri Sriram
GSW	Gursar Shnewala
GSX	Gandhi Smarak Road
GSY	Ghanshyamgadh
GT	Ghatkesar
GTA	Golanthra
GTBN	Guru T B Nagar
GTD	Gourinathdham
GTE	Gothaj
GTEN	Gujarat Torrent Energy Corpn Ltd Siding
GTF	Gumthal
GTH	Ghanta
GTHT	Ghataro Halt
GTI	Ghutai
GTJT	Getor Jagatpura
GTK	Ghutku
GTKD	Gerita Kolvada
GTL	Guntakal Jn
GTLB	Guntakal Bye Pass Cabin
GTLM	Gotlam
GTLW	Guntakal West
GTM	Ghatampur
GTMR	Girmint Colliery Sdg.
GTMS	Temp. Material Rly Sdg, Ghaziabad
GTNR	Gomti Nagar
GTP	Ghatpuri
GTPS	Rajasthan State Electricity Board Thermal Power House Siding
GTQ	Gumtali Halt
GTR	Bombay Grnt Road
GTRA	Gotra Halt
GTS	Ghatsila
GTST	Gautamsthan
GTT	Gomta
GTU	Ghat Nandur
GTW	Gatora
GTWD	Ghatwad
GTX	Gothangam
GTXN	New Gothangam
GTY	Gola Pati
GUA	Gua
GUB	Gularbhoj
GUD	Galudih
GUDM	Gudum P. H.
GUG	Garh Jaipur
GUGD	Ggd Jais
GUH	Guldhar
GUJ	Gunja
GUK	Guntakonduru
GUL	Gujjangivalasa
GULR	Guler
GUMA	Guma
GUMI	Gorumahisani
GUNA	Guna
GUNS	Ghunas
GUP	Gauripur
GUR	Ganagapur Road
GURN	Gurudas Nagar
GUS	Ghumasan
GUSB	Ghumasan BG
GUSG	Gun Shop Siding Jabalpur
GUSN	New Ghumasan
GUU	Gundratimadugu
GUV	Guruvayur
GUX	Gurhi
GUZ	Gumani Hat
GV	Govandi
GVA	Ganguvada PH
GVB	Guneru Bamori
GVD	Gholvad
GVDP	Govindpur PH
GVG	Govindgarh
GVGN	New Mandi Govind Garh
GVH	Govind Garh
GVI	Garividi
GVKK	M/S Punjab State Power Corporation Limited
GVL	Gudlavalleru
GVMH	Gangavaram
GVMR	Govindi Marwar
GVN	Godavari
GVP	Gate Vanampalli
GVR	Goreswar
GVSG	Food Corporation of India Siding Timmancheral
GVV	Galvav
GW	Girwar
GWA	Ganj Dundwara
GWCB	Gondawali Coal Siding
GWCN	Gurla 'w' Cabin
GWD	Gadwal
GWH	Ghoshawar
GWL	Gwalior Jn
GWM	Gannavaram
GWO	Gwalior NG
GWP	Gangawapur Halt
GWS	Gaushala
GWSB	Goindwal Sahib
GWV	Gowdavalli
GWYR	Greenways Road
GXG	Geong
GXSG	Godavari Khani No. 6 Colliery
GY	Gooty
GYF	Gooty Fort
GYJ	Gooty Cabin
GYL	Gharyala
GYM	Gudiyattam
GYN	Gyanpur Road
GZA	Gurujalas
GZB	Ghaziabad
GZH	Gulzarbagh
GZKA	Gazika
GZL	Gazulapalli
GZM	Gour Malda
GZN	Naya Ghaziabad
GZO	Gazole
GZS	Gz Sandhwan
GZT	Ghazipur Ghat
HA	Hargaon
HAA	Harwada
HAB	Bah
HABS	Hyderabad Ind Ltd Siding
HACG	HINDALCO Industries Ltd.
HAD	Haripad
HAG	Halligudi
HAH	Hosa Agrahara
HAK	Hadala
HAM	Hamirhati
HAN	Hindaun City
HAPA	Hapa
HAPR	Hanamapur
HAQ	Hastavaramu
HAR	Hamirpur Road
HAS	Hassan
HAT	Hathuran
HATB	Hatibari
HATI	Hati
HAUR	Haur
HAY	Hautleyhautley
HB	Habra
HBB	Hendlaso Bhokta Bagicha
HBD	Hoshangabad
HBE	Habibpur
HBF	Hadobhangi
HBG	Howbagh Jabalpur
HBI	Hgribomanahalli
HBJ	Habibganj
HBL	Hombal
HBLN	Hbl Nagar
HBN	Haibargaon
HBP	Harpar Bochaha
HBQ	Hubballi East Cabin
HBS	Hebsur
HBSG	Haryana State Electrical Board Siding Faridabad
HBSH	Hasan Bazar Station Halt
HBTI	M/S Hindustan Petroleum Corporation Ltd
HBU	Halbarga
HBW	Habibwala
HBZ	Heslaberaheslabera
HC	Hindu College
HCAB	Bhilai H Cabin
HCF	Hindustan Cable Fy. SDG Rupnarayanpur
HCGH	M/S Hasti Petro Chemical&shiping Pvt Ltd
HCJ	Hindustan Paper Corpn Ltd (P) BG
HCM	Hrschndrapuram
HCNR	Hari Chandanpur
HCP	Harchandpur
HCR	Harischandrpur
HCSP	M/S Hmp Cement (ACC) Sdg,porbander
HD	Harda
HDA	Hirnoda
HDB	Haldibari
HDC	Harishdadpur PH
HDCB	Haldia Dock Comp. Bulk.
HDCG	Haldia Dock Complex
HDCL	M/S Hindustan Engineering & Industries Ltd Ballygunge Jn
HDD	Haddinagundu
HDE	Hardas Bigha
HDGR	Hadgaon Road
HDIH	Hoodi Halt
HDK	Handia Khas
HDL	Hodal
HDM	Hirdamali
HDN	Haidarnagar
HDP	Hadapsar
HDS	Haridaspur
HDT	Hardattpur
HDU	Hardua
HDW	Haldwani
HDWL	Hardorawal
HDYD	Holding Yard
HEB	Hebbal
HEBS	M/S. Haldia Energy Ltd.
HEGM	Heg Siding Mandidip
HEI	Heggere Halt
HEM	Himayatnagar
HEN	Henria PH
HENS	Heavy Engineering Corporation
HEOC	Hathbandh East Outer Cabin
HER	Her
HESG	Bharat Heavy Electricals Ltd. Bhopal
HESK	Hire-Shellikeri
HET	Hetampur
HFG	Haflong Hill
HFS	Hari Fertilizer Siding, Vyn
HFZ	Hafizpet
HG	Hotgi
HGA	Hogla
HGCC	Hotgi Chord Cabin
HGH	Haidergarh
HGI	Hagari
HGIN	Hindustan General Industries
HGJ	Harduaganj
HGL	Harangul
HGR	Himgir
HGSM	Hindustan Granite Stone & Hindustan Industries Mining C
HGT	Hinganghat
HGTS	M/S. HPCL-Gati Shakti Multi-Modal Cargo Terminal Served By Sivadi
HGY	Hooghly
HHAL	Hehal
HHD	Hunsihadgil
HHFH	Hindustan Housing Factory Siding
HHG	Hehegara Halt (E)
HHL	Hirehali
HHP	Harhar Fatehpur
HHR	Hridaypur
HHT	Habanghata
HIBP	Haldibari International Border Point
HIH	Hajigarh
HIJ	Hijli
HIKD	Hallikhed K
HIL	Hilsa
HIMB	Mahan Aluminium Smelter and Captive Power Plant
HIND	Hind
HIP	Haldipada
HIPR	Haripar
HIR	Harinagar
HIS	Hisua
HISE	Hirisave
HIVR	Hiwarkhed
HIWS	Hirakund Industrial Works Siding
HJI	Hojai
HJL	Hejjala
HJLI	Hugrajuli
HJMS	Hestings Jute Mills SDG Rishra
HJN	Howrah Cabin
HJO	Harangajao
HJP	Hajipur Jn
HK	Helak
HKD	Hailakandi
HKG	Hirakud
HKH	Haranya Kheri
HKL	Harkia Khal
HKNT	Hiwarkhed
HKP	Hakimpur
HKR	Hiwarkhed
HKUR	HKUR Station
HLAR	Hole Alur
HLB	Hadala Bhal
HLBK	M/S HPCL Lpg Bottling Plant Kur
HLD	Haludpukur
HLDD	Haldi Road
HLDR	Haldaur
HLE	Heelalige
HLG	Hilligrove
HLGR	Halgeri Halt
HLIN	Holding Line
HLK	Holalkere
HLKH	Hallikhed
HLKT	Halakatta
HLL	Halol
HLN	Hole Narsipur
HLP	Haldharpur
HLR	Halisahar
HLRS	Halishahar Stores Depot
HLSG	Hindustan Lalpeth Colliery Sdg.
HLSR	Hindustan Steel Ltd At Rakshi
HLV	Haliyuru
HLW	Hirnawali
HLX	Hilara
HLZ	Haldia
HM	Hadmatiya Jn
HMA	Humma
HMB	Harebetta
HMBD	Humnabad
HME	Hamre
HMEL	Guru Govind Singh Refinery Project HPCL Mittal Energy Ltd
HMG	Hamirgarh
HMH	Hanumangarh Jn
HMI	Himmatana
HMK	Hindumalkote
HML	Helem
HMLS	Hindustan Motor Ltd. SDG Bally
HMO	Hanumangarhtown
HMP	Hempur
HMPR	Hurmujpur Halt
HMQ	Himmatpura
HMR	Hamira
HMRR	Hamrapur
HMT	Himmatnagar
HMY	Harmuti
HMZ	Hind Motor
HN	Hathbandh
HNA	Honnavar
HNB	Hasanabad
HNC	Hindon Cabin
HND	Hindol Road
HNDR	Hendegir
HNEO	HNEO Station
HNG	Hirangaon
HNGM	Hinduistan National Glass Manufacturers SDG Rishra
HNH	Hanumanahalli
HNHL	Harnahalli
HNK	Hanakere
HNL	Hingoli Deccan
HNM	Hinautaramban
HNMN	Hanuman Station
HNN	Harana Kalan
HNPA	Handapa
HNR	Hansara
HNS	Hansi
HNSL	Haslang P. H.
HNU	Hanspura
HNWG	Hirdagarh-Nandan Washery Siding
HOD	Haldita Bihar
HOH	Honaganahalli
HOJ	Hamitonganj
HOL	Hol
HOM	Chennai Harbour
HP	Haripur
HPA	Hampapura
HPCA	Hpc Siding
HPCD	Bharat Petroleum Corporation Ltd., Desur
HPCE	Hindustan Petroleum Corporation Ltd. Sid
HPCG	Hindustan Petroleum Corpn. Ltd
HPCH	Hindustan Petroleum Ltd
HPCM	HPCL Siding
HPCP	Hindustan Paper Corpn Ltd (P) (MG)
HPCR	Hpc Ltd Siding (bg)- Khari Rohar Road
HPCS	Hindustan Petroleum Corporation Ltd
HPCT	HPCL Siding
HPCV	HPCL Siding Vpt
HPG	Huppuguda
HPGH	M/S Hasti Petro Chemical&shiping Ltd Gati Shakti Multi Modalcargo Terminus
HPGM	Haripur Gram
HPH	Hanumapura
HPHI	Harapanahalli
HPI	Harpatti Halt
HPIL	Hempur Ismail
HPKA	Hinotia Pipalkhera
HPKB	M/S Hindustan Petroleum Corporation Ltd.
HPL	Haripal
HPLC	Hindustan Petroleum Corporation's Oil Bhilavdi
HPLE	Hatpuraini
HPLG	Hindustan Petroleum Corporation's Oil Terminal SDG Loni
HPLX	Loni Yard
HPM	Hampapatnam
HPO	Hasanpur Road Jn
HPOB	Hindustan Petroleum Oil Depot SDG Served By Bkpt Stn
HPP	Harpalpur
HPPK	HPCL Siding Paradeep
HPPL	M/S. Hindustan Petroleum Corporation Ltd.(hpcl)
HPR	Hirapur
HPRD	Hapa Road
HPRN	New Haripur
HPSB	HPCL Pol Siding
HPSG	Pol SDG For Hirenandure
HPSK	Hindustan Petroleum Corpn. Ltd. SDG Mg, Khari Rohar Road
HPT	Hosapete Jn
HPTD	Hosapete D Cabin
HPTK	Hindustan Petroleum Corporation Ltd. Siding Served By Tiruparankundram
HPTR	M/S Hindustan Petroleum Corporation Ltd.
HPU	Hapur
HPUN	New Hapur
HPUR	Hamrapur
HQR	Hirenanduru
HR	Harpalu
HRB	Harri
HRBR	Harubera
HRCF	Rail Coach Factory Rly Sdg, Hussainpur
HRDR	Harsar Dehri
HRE	Hirodih
HRF	Harhras Qilah
HRG	Hirdagarh
HRGR	Harnagar
HRH	Harthala
HRI	Hardoi
HRLI	Harlaya
HRLT	Harlatanr
HRM	Hadmadiya
HRN	Harauni
HRNG	Harpur Nag (Halt)
HRNR	Hira Nagar
HRNS	Pakdaha Harinsing
HRO	Harua Road
HRPG	Harpalganj
HRR	Harihar
HRS	Hathras Jn
HRSB	Hillar Shahabad Halt
HRSG	Harsingra Halt
HRSN	Harisinga
HRSR	Harish Nagar Halt
HRT	Harnaut
HRTK	Hortoki
HRV	Harrad
HRW	Harrawala
HSA	Hasimara
HSB	Hasanbazar Halt
HSD	Hosdurga Road
HSDA	Hansdiha
HSI	Harsauli
HSJ	Hussain Sagar Jn
HSK	Harishanker Road
HSKUR	HSKUR Station
HSL	Hisvahal
HSLD	M/S Hsl Steel Plant Sdg, Awz
HSLH	M/S Hindusthan Steel Ltd
HSLN	SAIL Siding Naini
HSLR	Hindustan Steel Ltd At Rangra
HSLT	Hidustan Steel Ltd , Tkd
HSM	Hausnagar
HSME	Hirapur Steel Exchange Yard (Iisco)
HSP	Hasanparti Road
HSPG	Hindustan Steel Ltd. Plant Siding At Bndm
HSQ	Husainpur
HSR	Hisar
HSRA	Hosur
HSTL	Hindustan Steel Ltd Siding
HSW	Husainiwala
HSWS	Hansiawas
HSX	Hoshiarpur
HSY	Harsingpur Goba
HSYG	SAIL Siding, Ballabgarh
HT	Hotar
HTA	Hatighisa
HTC	Hathras City
HTCY	High Tech City
HTD	Hatundi
HTE	Hatia
HTGR	Hathigadh
HTJ	Hathras Road
HTK	Hatkanangale
HTL	Hatikhali
HTLA	Hatola
HTN	Hatna Pur
HTNL	Hitnal
HTPP	M/S. Hind Terminal Pvt. Ltd.
HTR	Hatkarota Halt
HTSG	Bharat Heavy Electrical Std Siding
HTT	Hatra Road
HTW	Hathua
HTZ	Hathidah Jn
HTZ1	Hathidah Link Cabin
HTZU	Hathidah Jn Upper
HUBG	Hindustan Urvarak & Rasayan Ltd, Gati Shakti Multimodal Cargo Terminal
HUD	Hudukula
HUDU	Hundur Halt
HUFP	Harauli Fatehpur
HUGS	Hindustan Urvarak & Rasayan Ltd, Gati Shakti Multimodal Cargo Terminal
HUK	Holambi Kalan
HUN	Y Hunasenahalli
HUP	Hindupur
HURN	Hindustan Urvarak Evam Rasayan Limited Siding,gorakhpur
HVD	Halvad
HVL	Honnavalli Road
HVM	Hamsavaram
HVR	Haveri
HW	Haridwar Jn
HWH	Howrah Jn
HWHG	Howrah Goods Cabin
HWPL	Howrah Punjab Line
HWR	Hatwar
HWT	Hanwant
HWX	Habaipur
HX	Cuddapah
HXR	Hansapore
HYA	Hadiaya
HYB	Hyderabad
HYG	Hooghly Ghat
HYL	Hadyal
HYSG	Hyderabad Asbestos Industries Ltd
HYT	Hayaghat
HZBN	Hazaribagh Town
HZD	Hazaribagh Road
HZH	Hazratpur
HZL	Hindustan Zinc Ltd Siding
HZN	Hazrat Nagar Halt
HZR	Hafizpur
IAA	Indara Jn
IACL	Hindal Co Industrial Ltd. SDG -Lohardaga
IACM	M/S. HINDALCO Industries Ltd. At Muri
IAGR	M/S Gateway Rail Freight Limited (Grfl)
IAM	Mai Halt
IAMR	ICD Siding, Anajmandi, Rewari
IB	Ib
IBBM	M/S. International Cargo Terminals&rail Infrastructure Pvt. Ltd.
IBH1	Ibh1
IBH2	IBH2 Station
IBH3	IBH3 Station
IBHC	IBHC Station
IBHD	IBHD Station
IBHE	IBHE Station
IBHF	IBHF Station
IBL	Indrabil
IBPC	Ibp Co. Ltd (no 6 Shed & 10 Shed ) Bgb
IBTB	Ib Thermal Pwr Stn of M/S Opsg
ICAK	M/S. Adani Logistics Ltd.
ICB	Oil Refinery Siding
ICBB	IOC Ltd Sdg. Bakania Bhaunri
ICBD	Bhusaval ICD Container Depot
ICBN	Mughal Sarai Icbn Cabin
ICBR	IOC Ltd Siding Vasai Road
ICCB	M/S India Coal Centre SDG Bhadreshwar Ghat
ICCC	M/S Imfa Limited
ICCG	Indian Copper Complex, Ghatsila
ICDA	Inland Container Depot Amingaon
ICDB	Inland Container Depot, Ballabhgarh
ICDD	Inland Container Depot,dadri
ICDG	Inland Container Depot,juhi/Kanpur
ICDK	ICD Kanakpura Siding
ICDM	Inland Container Depot,malanpur
ICDP	Inland Container Depot Dapper
ICDR	ICD Served By Desur
ICDS	Inland Container Depot Siding Sabarmati
ICDT	CONCOR - Tondiarpet Container Terminal
ICDW	ICD Served By Sgwf
ICDY	Inland Container Depot,yamuna Bridge
ICG	Ichchangadu
ICGH	Ichangadu Halt
ICK	IOC Ltd Siding (hazira)-Kosad
ICKR	IOC Ltd Siding (BG) - Khari Rohar Road
ICL	Ichauli
ICLS	The India Cements Limited
ICLV	The India Cements Limited
ICLY	India Cements Ltd
ICM	The Ramco Cements Ltd SDG/Icg
ICMB	Inland Container Depot Moradabad
ICML	Integrated Coal Mines Ltd. Sdg.
ICMS	Inland Container Depot Madho Singh
ICOD	Inland Container Depot Okhla
ICPH	Inland Container Depot /Phillaur
ICSD	IOC Siding Daurai
ICSG	India Cements Siding
ICSI	India Cement Siding, Ichchangadu
ICSK	IOC Ltd. Sdg, Mg, Khari Rohar Road
ICSM	IOC Siding-Sabarmati (BG)
ICSP	Inland Container Depot Sonipat
ICSS	IOC Siding (MG) Sabarmati
ICY	Indian Custom Yard
IDAR	Idar
IDBR	ICD Birganj
IDCS	Kalinga Iron Works of M/S Industrial Dev Corpof Orissa
IDG	Indargarh
IDGH	Indargarh
IDGJ	Iradatganj
IDH	Idgah Agra Jn
IDJ	Idalhond
IDL	Indalvai
IDM	Indemau
IDP	Indupalli
IDR	Indi Road
IDS	Iswardaspur
IDSS	Izzatnagar Diesel Shed Siding
IDT	Sidlaghatta
IELR	M/S Ici India Ltd. SDG . Rishra
IFAB	IFFCO Siding
IFCO	IFFCO Cabin
IFFB	IFFCO Siding-Khodiyar
IFFG	IFFCO Siding - Shirva
IFFM	IFFCO Siding - Kalol (MG)
IFFP	IFFCO Siding
IFSG	IOC Siding Simaria
IGCS	CONCOR Siding At Irugur
IGFC	Indorama India Private Limited
IGL	Iringal
IGP	Igatpuri
IGPX	Igatpuri Yard
IGR	Ingur
IGRL	Ingorala
IGTA	Ingohta
IGU	Irugur
IHP	Inchhapuri
IIDA	M/S. Ircon/Dfc Siding
IIEL	M/S Indianoil Adani Ventures Limited
IISD	M/S. SAIL (Iisco)
IISM	M/S Iron & Steel Co. Sdg, Manoharpur
IJ	Itaunja
IJK	Irinjalakuda
IK	Ikran
IKC	Ikarchala
IKD	Ikdori
IKI	Itikyala
IKK	Ikkar
IKR	Iklehra
IKRA	Ikra Jn
ILA	Silaiman
ILBP	Lpg Bottling Plant SDG of IOC Ltd Kyi
ILO	Illoo
IMAM	Imampuram
IMBG	Imlibigha Halt
IMFS	Metal & Steel Fy . SDG Ichhapur
IMFT	Imfa Limited Siding
IMGE	Ismailpur
IMLI	Imli
IMR	Ibrahimpur
INCI	Ishan Chandi Halt
INDB	Indore Jn
INDM	Indore Jn
INDR	Indiranagar
INDRG	Indra Nagar
INJ	Innanje
INK	Intakanne
INP	Indapur
INS	Indas
INTY	Andal Inter Yard Cabin
IOA	IOC Siding, Asoti
IOBD	Indian Oil Siding Served By Bod
IOBP	IOC Bottling Plant, Ghevrah
IOBT	Pol Sdg. For M/S IOC/BPCL Tadali
IOC	Pol Siding For IOC Ltd Shirud
IOCD	IOC/Bpc Ltd
IOCE	IOC Jujharpur Et
IOCG	IOC Siding ,bad
IOCM	IOC Siding-Mangliagaon
IOCR	IOC SDG Rajbandh
IOCS	IOC Siding Subedarganj
IOCT	IOC Siding Tatanagar
IODT	Iocl, Siding (pvt/Bg), Dharmanagar
IOG	IOC Ltd (hazira)-Gothangam
IOGM	IOCL (Pvt/BG) Siding Gumto
IOGS	IOCL (BG/Pvt.) Siding, Digboi
IOHR	M/S IOCL/Hpcl, Rdm
IOJB	Banspani Iron Ltd
IOK	IOC Siding Kur
IOMB	M/S Iocl, Moinarband
ION	IOC Assisted Siding (bg), Njp
IOND	M/S Indian Oil Corporation
IONI	IOC Siding Narioli
IOPB	IOC Siding (P) (BG) Pathorkhola
IOPK	IOC Siding Panki
IORG	India Oil Refinery Siding
IORR	Joint Oil SDG of M/S Hpc and IOC Rourkela
IOSB	IOC Siding, Bgtn
IOSD	IOC Siding (P) (BG) Dimapur
IOSG	Indian Oil Blending Siding
IOSH	Hanumangarh IOC Siding
IOSJ	IOC Siding, Scpd
IOSM	Indian Oil Copn Ltd
IOSP	Indian Oil Corporation Paradeep
IOSR	IOC Siding Raxaul
IOTS	Indian Oil Corporation Tank Wagon Siding Served By Salawas
IP	Ichhapur
IPCD	M/S Indian Port Rail Corporation Limited Dry-Port
IPCP	M/S IOCL Pet Coke Siding
IPG	Ippuguda
IPL	Idapalli
IPM	Ichchpuram
IPN	Irumpanam Yard
IPPM	Ipurupalem
IPPN	Ipurupalem Halt
IPR	Islampur
IPRA	Islampara Halt
IPT	Ichchiputtur
IPTN	Ispatnagar
IQB	Iqbalpur
IQG	Iqbal Gadh
IRA	Israna
IREL	Pft of M/S Irel (India) Limited
IRFB	Rifle Fy SDG Ichhapur
IRLS	Kharia Khangar Cement Siding
IRN	Irgaon
IRNGR	Iranagaram
IRP	Iravipuram
IRPN	Indian Oil Refinery Siding (P) (BG) Noonmati
ISA	Isarda
ISCG	Bunker Siding At Gua For M/S. Indian Iron & Steel Co. Ltd.
ISF	IOC Siding, Feroke
ISH	Isarwara
ISHN	Ishanagar
ISM	Ismaila Haryana
ISMC	IOC Siding Malda Court (P)
ISNL	M/S Adani Logistics Sevices Private Limited
ISPB	Iisco Steel Plant of M/S. Iisco
ISPM	IOC Siding (P) (MG) Pathorkhola
ISRI	Ishapur Kheri Halt
ITA	Itola
ITCL	Itc (Iltd) Ltd.
ITCM	Imperial Tobacco Co. Ltd . Monghyr
ITE	Intiyathok
ITKL	Itaya Kalan
ITKY	Itky
ITLS	Itc (Iltd) Ltd.
ITR	Itwari
ITRN	Itwari NG
ITRY	Itarsi Yard
IUIK	M/S. Indus Udyog and Infrastructure Pvt. Ltd.
IVL	Ilavelangal
IWPS	Inland Waterways Authority of India, Port Siding, Pandu
IYCI	Itarsi Yard Coal Siding
IZN	Izzatnagar Jn
IZNS	Izzatnagar Workshop Siding
J	Jalna
J1	J1 Station
JA	Jaliya
JAA	Jhalida
JAB	Yamuna Bridge Jn
JABA	Yamuna Bridge (Agra) Cabin
JAC	Jalsu
JACN	Jalsu Nanak
JACS	Andhra Sugars Ltd
JADR	Jadar
JAG	Jalalgarh
JAIC	Jais City (Kasimpur)
JAIS	Jais
JAJ	Jhajha
JAJB	Jhajha Ballast Siding
JAK	Jakanur
JAKA	Junakhera
JAL	Jawali
JALD	Jaliya Devani
JALN	New Jawali
JALNA	JALNA Station
JAM	Jamnagar
JAMA	Jama
JAN	Jarangdih
JAO	Jaora
JAPN	Jhalrapatan
JAQ	Jandrapeta
JAR	Junair Halt
JARI	Jari
JAS	Jasdan
JASH	Jorashankh Halt
JAT	Jammutavi
JATP	Jaitpura
JAU	Jhaua
JAUA	Jamua
JAW	Jarwa
JBB	Jambur
JBC	Jambrung
JBCN	Joda Block Cabin
JBCT	M/S. Nuvoco Vistas Corporation Ltd
JBD	Jallalabd
JBG	Jung Bahadurgnj
JBGD	Jabbalgudda
JBH	Jiabharali
JBJC	Jamuna Block Hut Jn Cabin
JBK	Jaggambhotla Krishnapuram
JBL	Jabli
JBN	Jogbani
JBO	Jamadoba PH
JBP	Jabalpur
JBR	Jahangirabad Rj
JBRA	Jhabrera
JBRT	Jp Bela Siding
JBS	Jadoli ka Bas
JBSR	Jambusar Road
JBTS	Jaypee Bina Thermal Power Plant Siding
JBU	Jaabugam
JBW	Jhabelwali
JBX	Jabri
JCBR	Jainagar Colliery
JCG	Jn Cabin Gondia
JCGA	Gati Shakti Multi-Modal Cargo Terminal of M/S J K Lakshmi Cement Ltd.
JCH	Jetha Chandan
JCL	Jadcherla
JCLG	Jayashri Chemical Limited
JCMS	Jamuna Open Cast Mines
JCN	Junichavand
JCNR	Juchandra
JCS	Jogta Coal Siding
JCSK	M/S JSW Steel Coated Products Limited
JCSP	Jgb No. 6 Colliery Siding, Patherdih
JCSS	Jayanth Colliery Siding
JCU	Jaicholi
JCWS	Jamul Cement Works Ltd Bia
JCY	Jind City
JCZ	Jhingurdah Colliery Siding
JD	Jarod
JDA	Jasoda
JDB	Jagdalpur
JDD	Jerthi Dadhia
JDDA	Jetha
JDGP	Jamaldaha Gopalpur
JDH	Jam Jodhpur Jn
JDHH	Jandhera Halt
JDI	Jharradih
JDK	Jandoke
JDL	Jagdevwala
JDN	Jagudan
JDNM	Jagudan
JDNX	Joginder Nagar
JDP	Jadabpur
JDPR	Oro
JDPT	Jagdishpur
JDR	Jiwdhara
JDW	Jaruda Naraa
JDWN	New Jarauda Nara
JDWS	Jamadoba Washery Siding
JEA	Nakaha Jungle
JEMT	M/S Jamshed Pur Engg & Machine Mfg. Co. Ltd. Tatanagar Jn
JEN	Jenapur
JEO	Jitoda
JEP	Jeonathpur
JER	Jaleswar
JES	Jaitsar
JESG	Jabalpur Arsenal Depot Siding
JET	Secbad James St.
JEUR	Jeur
JFAI	FCI Siding Jharsaguda
JFD	Jiadhal
JFG	Jafarganj
JGA	Jogiara
JGBR	Jogeshwar Bihar
JGD	Jagadishpur
JGDL	Jagadal
JGE	Jgnth Tmpl Gte
JGF	Jogidih
JGG	Jangiganj
JGI	Jhagadiya Jn
JGJ	Jagesharganj
JGJN	Jugijan
JGKS	Jigni Khas
JGLP	Jatinga Lumpur
JGM	Jhargram
JGN	Jagraon
JGNR	Jogendra Nagar
JGP	Jalalpur
JGPM	Jaggayapalem
JGR	Jaswantnagar
JGW	Jogiwala
JGWL	Jagjivan Halt
JGX	Jariagarh
JGZ	Jamgoaon Halt
JHA	Jakhaura
JHAR	Jhar
JHBN	Jmtpur Baharan
JHD	Jehanabad
JHDC	Jahanbad Court
JHG	Jhingura
JHH	Jhalra
JHIR	Jhir
JHJ	Jhajjar
JHK	Jethuke
JHL	Jakhal Jn
JHMR	Jhimri
JHN	Jakhim
JHP	Jujharpur Cabin
JHS	Jhansi Jn
JHSA	Jhansi A Cabin
JHSW	Jhansi Workshops
JHT	Junehta
JHW	Jhalawar Road
JHWR	Jhawar
JI	Jhusi
JI2	Jhusi 2
JIA	Jigna
JIBI	Jolaibari
JID	Jagi Road
JIGT	Jirighat
JIL	Jalila Road
JIND	Jind Jn
JIR	Jira Road
JIT	Jirat
JITE	Jite
JJ	Jajau
JJA	Jajan Patti
JJBR	Jhanjharpur Bazar Ha
JJG	Jiaganj
JJJ	Jaijon Doaba
JJK	Jhinjhak
JJKR	Jajpur K Road
JJN	Jhunjhunu
JJP	Jhanjharpur
JJPR	Jhanjharpur Bazar Halt
JJR	Jejuri
JJT	Jai Jai Wanti
JJTI	Jhanjhitoli Halt
JJW	Jojwa
JK	Jakolari
JKA	Jakhvada
JKAR	Jaklair
JKB	Jakhalabandha
JKCG	M/S J K Cement Siding-Mangrol
JKCM	J K Cement Works Ltd Served By Mohanbari
JKDA	Jamkundia
JKDK	Jharkhand Dham Halt
JKDL	Jaipuria Kajora Colliery Sdg.
JKDP	Jankidaipur
JKE	Jukehi
JKH	Jahanikhera
JKHI	Jakhod Khera
JKI	Kauriaa Jungle
JKL	Jalalkhali Halt
JKM	Jankampet Jn
JKMH	Jharkhand Mahadev Halt
JKN	Jakhanian
JKNI	Jharkhandi
JKO	Jakkalacheruvu
JKP	Jharekapur
JKPR	Jakhapura
JKR	Jaulkhera
JKS	Jaksi
JKT	Jekot
JKTP	Jukal
JKZ	Jitakheri
JL	Jalgaon Jn
JLBR	Jhallurbar
JLD	Jarwal Road
JLF	Julmi
JLG	Julgaon Deccan
JLHI	Jhilahi
JLI	Jalasi PH
JLL	Jalalganj
JLLO	Jhilo
JLM	Jaliya Math
JLN	Jakhalaun
JLP	Jalalpur Mandwa
JLPH	Jalalpur Halt
JLQ	Jalpur
JLR	Jetalsar Jn
JLS	Jalesar Road
JLT	Jhamat
JLW	Jhalwara
JLWC	Jhalawar City
JLY	Jhilmili
JM	Jalamb Jn
JMA	Jamuria
JMB	Jambusar Jn
JMBC	Jambusar City
JMBL	Jambhali Halt
JMD	Jamdha
JMDG	Jammalamadugu
JMDT	Joda East Bin Iron Mines
JME	Jamsher Khas
JMG	Jamga
JMI	Jamguri
JMIR	Jamira Halt
JMK	Jamunamukh
JMKL	Jamuniya Kalan
JMKR	Jawlmukhi Road
JMKT	Jamikunta
JML	Jumnal
JMM	Jaimurtinagar
JMN	Jamuawan
JMNK	Block II Jamuni Washery Siding
JMNR	Jamner
JMP	Jamalpur Jn
JMPT	Jimidipeta
JMPW	Jamalpur Workshop
JMQ	Jamirghata
JMRA	Jamira
JMS	Jamsar
JMSY	Jamalpur Stores Yard
JMT	Jamtara
JMTC	Joda East Direct Entry Pvt. Sdg. of M/S. Tata Steel Ltd.
JMU	Jamui
JMV	Jambara
JMX	Jamuni
JN	Jhund Jn
JNA	Julana
JNCB	Jn Cabin, Vsps
JNCN	J. K. Nagar Colly. SDG
JNCP	Jb No 9 Colliery Siding
JNCS	Jayant Silo (03) GCT of NCL
JNCV	Morinda Jn Cabin
JND	Junagadh Jn
JNDM	Junagadh
JNDO	Jahanabad Court
JNDW	Junagadh Workshop
JNE	Janiyana
JNH	Janghai Jn
JNJ	Jui Nagar
JNK	Jhinkpani
JNKR	Janakinagar
JNL	Jandiala
JNM	Jayngr Majlipur
JNN	Jamuniatanr Halt (E)
JNNA	Jamuniatanr Halt (for Shcddule)
JNO	Junnor Deo
JNP	Jagan Nathapur
JNPD	Janpahad
JNPT	Jawaharlal Nehru Port Trust
JNQS	Jamalpur New Quarry Siding
JNR	Janakpur Road
JNRD	Junagarh Road
JNRI	Jalandari
JNSC	Bhatinda Cantt Jn Cabin
JNT	Jaintipura
JNTR	Jinti Road
JNU	Jaunpur Jn
JNUK	Jaunpur Kutchary
JNX	Jagnathji Road
JNZ	Jenal
JO	Jo Jagabor
JOA	Janwal
JOB	Asalpurjobner
JOBA	Joba
JOBT	Jobat
JOC	Joychandi Pahar
JOCL	Jessop & Co. Ltd SDG Dumdum Cantt
JOH	Juharpura
JOK	Jodhka
JOKT	Jokatte
JOL	Jogal
JOM	Jogi Magra
JON	Johna
JONR	Jeonara P. H.
JOO	Jamai Osmania
JOP	Jaunpur City
JOQ	Jorai
JOR	Jalor
JOS	Jogeshwari
JOWY	M/S. Jagadish & Others FCI/Apswc Siding Served By Yerpedu Stn
JOX	Janai Road
JP	Jaipur Jn
JPAH	Jagdishpur A Halt
JPCC	M/S Jaypee Churk Industrial Complex (Jcic) Served By Churk
JPCT	Jayaprakash Cement Siding-Tanda
JPD	Jalalpur Dhai
JPE	Jalpaiguri Road
JPG	Jalpaiguri
JPH	Jhantipahari
JPI	Jhadupudi
JPL	Japla
JPLS	Jindal Pipes Siding
JPM	Jiyapuram
JPML	Jai Prakash Mahuli Halt
JPO	Jora Alapur
JPP	Jlalpr Panwara
JPQ	Jhapandanga
JPR	Jakpur
JPRD	Jenapur Road PH
JPRG	M/S. Jaypee Rewa Cement Ltd. Satna
JPS	Jmlpr Shaikhan
JPST	Jamrapani Siding,trdi
JPTE	M/S Jawaharpur Thermal Power Plant
JPTN	Jaggayya Peta Town
JPTR	Jitpur
JPV	Jmtra Paraswara
JPVN	M/S Jaiprakash Power Ventures Ltd. (thermal Power Plant) SDG
JPZ	Jogighopa
JQSG	Kymore Siding (acc Ltd.)
JRA	Jaraikela
JRAC	Jaroli - A Cabin
JRAE	Jaugram
JRBI	Jayrambati
JRBM	Jiribam
JRC	Jalandhar Cantt
JRCS	Jp Rewa Cement Siding Tzr
JRCT	Jaypee Rewa Cement Plant Siding
JREA	Jhareda
JRG	Jugpura P. H.
JRGD	Jarangdih Line No. II
JRGJ	Jairamnagar Public Siding
JRGR	Pvt. Sdg. Junadih Rapid Loading System of SECL
JRJ	Jargaon
JRJE	Garjee
JRK	Jeruwa Khera
JRKN	Jorkian
JRKT	Jadarama Kunte
JRL	Jharili
JRLE	Jangipur Road
JRLI	Jaroli
JRMA	Jharmunda
JRMG	Jairamnagar
JRNA	Jirnia
JRO	Jiron
JRPD	Jarapada
JRQ	Jharokhas
JRR	Jugaur
JRS	Joravasan
JRT	Jarati
JRTB	Jhartarbha
JRTR	Jurtara Halt
JRU	Chikjajur Jn
JRV	Juna Rajuvadiya
JRW	Joramow
JRWN	Jirwan
JRX	Juriagaon
JRZ	Joranda Road
JSA	Jasai
JSB	Yamuna South Bk
JSC	Jalesar City
JSCP	M/S JSW Cement Limited
JSD	Jaisingder
JSDJ	Jamalpur Store Depot SDG . Jmp
JSE	Jamsole
JSG	Jharsuguda Jn
JSGR	Jharsuguda Road
JSH	Jaswantgarh
JSI	Jasali
JSJB	M/S. JSW Cement Ltd
JSKA	Jataula Jauri Sampka
JSL	Jassowal
JSLE	Jasai Chirle
JSLK	M/S Jindal Steel Limited
JSLS	Pft of M/S Jindal Stainless Limited
JSM	Jaisalmer
JSME	Jasidih Jn
JSOR	Jessore Road
JSP	Jayasingpur
JSPC	JSPL Cabin A
JSPK	Private Siding of M/S Jindal Steel and Power Limited
JSPN	Jaspalon
JSPP	Jindal Steel Limited
JSPR	Jashapar
JSQS	Jamalpur Stone Querry SDG . Jamalpur Jn
JSR	Jasra
JSRD	Jhankad Sarala Road
JSRY	Jharsuguda R - Yard
JSS	Jasia
JSV	Jarandeshwar
JSWB	JSW Block Cabin
JSWD	JSW Steel Ltd. Siding
JSWN	M/S JSW Steel Limited Siding, Nandihalli
JSWT	JSW Steel Ltd
JSWV	M/S JSW Steel Coated Products Ltd.
JTB	Jagatbela
JTCG	Jain Tubes Co. Ltd Siding
JTDM	Jat Dumri Jn
JTG	Jatinga
JTH	Jhoktahal Sing
JTHR	Jethantri Halt
JTHT	Jn Hut Ddu
JTI	Jaithari
JTIN	Jtin
JTJ	Jolarpettai Jn
JTJA	JTJA Station
JTJB	JTJB Station
JTK	Jhitkia
JTKN	Jaitpur Kalan
JTL	Jhapater Dhal
JTN	Jotana
JTNU	Jatnandur
JTO	Jutogh
JTP	Jetpur
JTR	Jatkanhar
JTRD	Jath Road
JTS	Jatusana
JTSR	Jyotisar Halt
JTT	Jumma Patti
JTTN	Jorhat Town
JTU	Jaitipur
JTV	Jetalvad
JTW	Jaitwar
JTX	Jatpipli
JTY	Jethi
JU	Jodhpur Jn
JUA	Jarauna
JUBS	Jubbasahani
JUC	Jalandhar City
JUCT	Jodhpur Cantt
JUD	Yamunanagar-Jagadhri
JUDN	New Jagadhri Workshop
JUDW	Jagadhri Wshop
JUH	Jujharpur Cabin
JUI	Kanpur Juhi Goods Shed
JUJA	Jujomura
JUK	Jaulka
JUL	Jhulasan
JULD	Jambad Colliery Sdg.
JULM	Jhulasan
JULS	Jodhpur Loco Siding
JUMX	Jodhpur Mechanical Shop
JUNC	Jn Cabin ( Andal )
JUNX	Junona Halt
JUP	Jhunpa
JUR	Juturu
JUSG	Jabalpur Ordinance Depot Siding
JUYA	Jodhpuriya
JVA	Javale
JVL	Jamwala
JVN	Jorawarnagar Jn
JVRB	M/S Jalagam Vengala Rao Open Cast Mines of Singereni Colleries Co Ltd
JVT	Jibanti
JW	Jatwara
JWB	Jawai Bandh
JWK	Jwhrpur Kamsan
JWKA	Jand Wala Kharta
JWL	Jajiwal
JWLS	Jawanwala Shahr
JWN	Jiwa Arain
JWNR	Jawaharnagar
JWO	Jawad Road
JWOV	M/S. Vikram Cement Siding (BG)
JWP	Jwalapur
JWS	Jharwasaa
JXN	Jirona
JYG	Jaynagar
JYK	Jone Karrang
JYM	Jai Samand Road
JYP	Jeypore
JYS	Jaynagar Nepal Siding
KAA	Kaurara
KAC	Kasap
KAD	Khandala
KADA	Khandala Mp
KADH	Khairadih Halt
KADI	Kadi
KADL	Kumradol
KADM	Kukkadam
KADR	Kadiyadrakadiyadrakadiyadra
KAF	Kharida Goods Shed
KAFM	Armed Forces Medical Stores Depot Sdg, Kandivli
KAG	Kodaganur
KAGA	Kurhagada
KAGJ	Kaliaganj (Bihar)
KAGR	Kagangarh
KAH	Kalhar
KAHL	Karhal
KAI	Kairla
KAJ	Kaliyanganj
KAJC	Kalamna Jn Cabin
KAJG	Karanjgaon
KAK	Khaki Jaliya
KAKI	Kakni
KAKN	Kaimara Kalan
KAL	Kallal
KALI	Kaili
KALM	Kalamb
KALN	Kalana
KALS	Kalas Halt
KAMA	Kamta Halt
KAMG	Kamakhyaguri
KAMP	Kamalpur
KAMR	Kamr
KAMU	Karumathur Halt
KAN	Khana Jn
KAND	Kandla
KANG	Karan-Nagar
KANJ	Kanil
KANL	Khana Link Cabin
KANO	Kanoh
KANR	Kukanur
KANS	Kansiya Nes
KAO	Kalubathan
KAOT	Kaotha
KAP	Kalianpur
KAPE	Kakapora
KAPG	Kalupara Ghat
KAPM	Kottapalem
KAPP	Khariapipra Halt
KAPT	Krishnapatnam
KAPU	Kiratpur
KAQ	Kolanukonda
KAR	Karna
KARD	Kaman Road
KARH	Kakraha Rst Hse
KARI	Khari (Arpinchala)
KARJ	Karjhausa
KARK	Karaikkurichi
KARM	Karma
KARO	Khario
KARP	Kharkopar
KARR	Kharar
KART	Kiratpur Sahib
KASA	Kansa
KASG	Ammunition Factory Sdg, Khadki
KASH	Kulthamabdullashah H
KASN	K D Heslong Siding
KASR	Kanas Road
KASU	Kasu
KAT	Khatauli
KATA	Katili
KATB	Khatkura PH
KATI	Kathi
KATL	Katol
KATN	New Khatauli
KATR	Katariya
KAU	Kachna
KAUA	Kathautia
KAV	Kalumna
KAVI	Kavi
KAVM	Kathivakkam
KAVR	Kalavur Halt
KAW	Khajri
KAWL	Kandwal Halt
KAWR	Karwar
KAWT	Kanwat
KAY	Karaimadai
KAYI	Kaydi P. H.
KAYR	Kayer
KB	Khairatabad
KBA	Kurabalakota
KBBP	Kambiron
KBC	Kiul Bridge Cabin
KBCB	Khandwa Bypass Cabin
KBCS	Krishak Bharti Co-Op. Ltd. Siding
KBCT	M/S. Kalburgi Cement Private Limited
KBDR	Kambadur Halt
KBE	Kurebhar
KBGB	Budge Budge
KBGH	Karea Kdmbgachi
KBGN	Khubgaon
KBH	Khandbaara
KBI	Kambarganvi
KBJ	Kantabanji
KBK	Khambli Ghat
KBKN	Khabra Kalan
KBL	Koppal
KBM	Kotabommali
KBN	Karbigwan
KBP	Kuberpur Jn
KBPR	Kabaka Puttur
KBPS	Khridwa Bulk Cum Pack Petroleum Siding
KBQ	Kumrabad Rohini
KBR	Kabrai
KBRV	Kanjari Boriyavi
KBSH	Krishna Ballabh Saha
KBSN	Kasbe Sukene
KBT	Kadambattur
KBTS	Krishak Bharti Co-Op. Siding -Gothangam
KBU	Kasu Begu
KBV	Khan-Bhankri
KBY	Khoirabari
KCA	Kuchman
KCAB	K-Cabin Bndm
KCB	Kuslamb
KCBB	K Cabin/Bley
KCBN	K - Cabin
KCC	Krishna Canal
KCCJ	Konar CCL Siding
KCCN	Kota C Cabin
KCCS	M/S. Cement Division Unit of Kesoram Industries Ltd, (kesoram Factory)
KCD	Kurichedu
KCE	Kings Circle
KCF	Kalchini
KCG	Kacheguda
KCHA	Karchiya
KCHL	Korichhapar Line No. 01
KCHP	Korichhapar
KCHV	Kachchanvilai
KCI	Kallkiri
KCJ	Kasimpur
KCKG	Khaskajora Colly. SDG
KCKI	Keckhi
KCKN	Kumda Colliery
KCKT	Katkona Colliery
KCLA	Kenchanalu Halt
KCLS	Dalmia Dsp Ltd. Sonenagar
KCM	Kalasumudram
KCN	Karchana
KCNN	New Karchana Jn
KCNR	Kachnara Road
KCO	Kachhia Bridge
KCOD	Central Ordinance Depo Sdg, Kandivali
KCP	Kalgupur
KCPM	Kcp (Ramakrishna) Ltd
KCPS	Kcp Ltd Siding
KCR	Khonker
KCSA	Kumardihi A Colly. SDG
KCSD	Korea Blk No 1 & 2 Darritola
KCSP	Kottadih A Colly. SDG
KCSS	Kunustoria Colly. SDG
KCT	Kirakat
KCU	Kachhiaa
KCV	Krishna Ch Pura
KCVL	Thiruvananthapuram North
KCY	Kaichar
KCYN	Kachhiyana Halt
KCZ	Kairon
KD	Kundarkhi
KDAA	Kada
KDAG	Kyatsandra Depot
KDBA	Kodimbala Halt
KDBM	Khed Brahma
KDBR	Khadki Bazar
KDBS	Kotda Bavishi
KDCK	Kandivli Carshed
KDCY	Kevadiya
KDE	Koradacheri
KDER	Kunder Halt
KDF	Khundaur
KDG	Kedgaon
KDGH	Kodigehalli
KDGI	Kudgi
KDGL	Kondrapol
KDGO	Kadogaon Halt
KDH	Khardaha
KDHA	Karchha
KDHI	Kaladehi P. H.
KDHL	Kundhela
KDHN	Kandharan Halt
KDI	Kundli
KDJ	Khudaganj
KDJB	Khudaganj Bazar
KDJR	Kendujhar
KDK	Kohdad
KDKC	Kandivli Emu Shed
KDKL	Kodakandla
KDKN	Kendukana
KDL	Kankroli
KDLC	Kandla Port Container Siding
KDLG	Kundalgarh
KDLP	Kandla Port
KDLR	Kandel Road
KDM	Kesamudram
KDMD	Kandambakkam
KDMR	Khodiyar Mandir
KDN	Kudatini
KDNL	Kadayanallur
KDO	Kadakola
KDOS	K. D.(old) Siding
KDP	Kondapuram
KDPA	Khadapa
KDPR	Kumedpur
KDPS	Kadipur Sani Halt
KDQ	Kadipur
KDR	Kuda Salt Siding
KDRA	Kadampura
KDRD	Khuldil Road
KDRI	Kendri
KDRL	Kondrapole Halt
KDRP	Kandarpur
KDS	Kusunda Jn
KDSB	Khadur Sahib
KDSD	Kudsad
KDSK	Kusunda Siding
KDSN	K. D. Heslong Siding, Line No. II
KDT	Khadarpett
KDTN	Kadethan
KDTR	Kirodimalnagar
KDTY	Kaduturutti Halt
KDU	Kadambur
KDUH	Kunduru
KDV	Khadavli
KDVI	Kadavai
KDX	Kadabari Hat
KDY	Kettandapatti
KDYA	Kadarpur
KDZ	Kandaghat
KE	Khardi
KEA	Katra
KEB	Karambeli
KEBG	Karambeli Goods Shed
KEC	Kesimpa
KECM	M/S Karnataka Power Corporation Ltd
KED	Kenduapada
KEE	Kaseetar
KEF	Krishnammakona
KEG	Karengi
KEH	Kapseti
KEI	Kashi
KEJ	Kathleeghat
KEK	Karkheli
KEM	Kem
KEMA	Kukma
KEMK	Khem Karan
KEMP	Kempalsad P. H.
KEMR	Kemri Halt
KEN	Kotala
KENP	Kendrapara
KEP	Kelanpur
KEPR	Koiripur
KEQ	Kachhpura Jn
KER	Kirihrapur
KES	Kesri
KESK	Koderma Extension Public Siding (Pipradih)
KESN	New Kesri
KESR	Kesri Singhpur
KETI	Keoti
KEU	Kettur (Parewadi)
KEV	Kela Devi
KEX	Khekra
KEY	Kagankarai
KEZ	Kelzar
KFA	Koparia
KFAS	M/S Khandelwal Ferro Alloy Ltd
KFC	Kalpattichatram
KFCG	Food Corporation of India Siding.
KFCS	FCI Sdg, Karunagapalli
KFD	Karanjadi
KFE	Chottanikkara Road
KFF	Kolda
KFGB	Gati Shakti Cargo Terminal of KRIBHCO Fertilizers Ltd./Banthra
KFH	Katphal
KFI	Kappil
KFIG	M/S Kirloskar Ferrous Ltd Private Siding, Ginigera
KFK	Katka
KFN	Kanor
KFP	Kukra Khapa
KFPR	Kafurpur
KFQ	Kumaranallur
KFSG	High Explosives Factory Sdg, Khadki
KFT	Kajri
KFU	Kohand
KFV	Kundara East
KFX	Kochewahi P. H.
KFY	Karapgaon
KGA	Khaga
KGB	Kargi Road
KGBC	Karimganj Bypass Cabin
KGBP	Khongsang
KGBS	Kishangarh Balawas
KGCK	Kesargarh Colliery Siding
KGD	Kalligudi
KGE	Katangi
KGF	Kathghar
KGFE	Katghar East Cabin
KGFR	Kathghar Right Bank
KGG	Khagaria Jn
KGH	Kotegangur
KGI	Kengeri
KGIH	Kalgurki .h
KGK	Kankurgachhi Road Jn
KGKD	Kang Khurd
KGL	Kupgal
KGLE	Khagraghat Road
KGLI	Karghali Washery Siding
KGM	Kathgodam
KGMR	Kangra Mandir
KGN	Kurseong
KGP	Kharagpur Jn
KGPW	Kharagpur Workshop
KGQ	Kasaragod
KGRA	Kangra
KGS	Khongsara
KGV	Konagavalli Halt on Shivamogga-Talguppa line
KGVE	Konagavalli H
KGVL	Kadagara Valli
KGW	Kariganuru
KGWD	Kagwad
KGWS	Khargali Siding
KGX	Kanginhal
KGY	Kulgachia
KGZ	Karunguzhi
KH	Kahiliya
KHA	Khaigaon
KHAA	Kharaiadih
KHAG	Kharghar
KHAI	Khirai
KHAR	Khar
KHAT	Khat
KHBH	KHBH Station
KHBJ	Khanna Banjari
KHBV	Kharbao
KHC	Khorana
KHD	Khodiyar
KHDA	Khandiya
KHDB	Khodiyar
KHDH	Karahdih Halt
KHDI	Khanderi
KHDP	Khudlapur
KHDR	Khandrai
KHE	Kankather
KHED	Khed
KHF	Khantapara
KHGP	Khargapur
KHGR	Kashinagar Halt
KHH	Kichha
KHHJ	Khatkar Kalan J
KHI	Kurhani
KHJ	Khajraha
KHJA	Khanja Halt
KHKN	Khera Kalan
KHKT	Khotkhoti
KHLL	Ketohalli
KHM	Kusmhi
KHMA	Khatima
KHMP	Khempur
KHN	Khanyan
KHND	Khunvad
KHNM	Kunda Harnamgnj
KHNP	Khanapur Deccan
KHNR	Kachnara
KHOH	Khoh
KHPI	Khopoli
KHPL	Khalipali
KHPR	Khalipur
KHQ	Kharik
KHR	Khairee Halt
KHRA	Kachera
KHRI	Kharkhari
KHRJ	Khumbaraj
KHRK	Kharak
KHRS	Khareshwar Road
KHRY	Khairahi
KHS	Kharsia
KHSN	Khhera Sandhan
KHST	Kashanatti
KHT	Sri Kalahasti
KHTG	Khatgaon
KHTI	Kushtagi
KHTN	Khutauna
KHTU	Bari Khatu
KHTX	Khed Temple Hlt
KHU	Khurhand
KHUH	Kharuara Halt
KHUT	Khuntala
KHV	Karainthi
KHW	Kheroda
KHXB	Khakhrechi BG
KI	Kondapalli
KIA	Khari Amrapur
KIAD	KIA Airport Halt
KIAT	Kyatsandra
KIB	Kizha Ambur
KIBH	Koshi Block Hut Cabin
KIC	Kallidaikurichi
KID	Khairar Jn
KIE	Khiria Khurd
KIF	Kuri
KIFH	Kashipur Infrastructure & Freight Terminal Pvt. Ltd. Siding
KIG	Kolaghat
KIGL	Kunigal
KIHC	M/S KRIBHCO Infrastructure Ltd
KII	Kille
KIIP	KRIBHCO Infrastructure Limited ICD Served By Pali
KIJ	Kuldiha
KIK	Karaikal
KIKA	Kurwai Kethora
KIKN	KIKN Station
KIKP	Karaikal Port Pvt Ltd Siding
KILE	Kandivali
KIM	Kim
KIN	Kapasan
KIP	Khalilpur
KIPK	Komuravelli Punyakshetram
KIQ	Khai Phemeki
KIR	Katihar Jn
KIRB	Katihar Cbo Mb Cabin
KIRO	Katihar Outer Cabin
KIRP	Khidirpur
KIRW	Katihar South Cabin
KIS	Kapilas Road
KISG	Katni Ordnance Factory Sdg,katni
KISN	Kalisen PH
KIT	Khallikot
KITA	Kita
KITN	Khiri Town
KIU	Kinana
KIUL	Kiul Jn
KIV	Kailsa
KIW	Kanwalpura
KIY	Kalayat
KIZ	Kansudhi
KJ	Kajgaon
KJA	Khajurhat
KJC	Kasganj City
KJDI	Khajjidoni
KJG	Karajgi
KJGY	Khanalampura Marshalling Yard
KJH	Kajra
KJI	Khajauli
KJJ	Kodavaluru
KJKD	Kanjikode
KJL	Khumgaon Burti
KJLU	Khari Jhalu
KJM	Krishnarajapurm
KJME	Kajoragram
KJMG	Kanjur Marg
KJMS	Food Corporation of India Grain Godown S
KJN	Kannauj
KJNC	Kannauj City
KJNY	Khajpur Naya
KJP	Khojeepura
KJPD	Kurinjipadi
KJR	Kalajhari- Bh
KJRA	Karjana
KJRD	Kanjur Marg
KJRG	Keshra-Katjuridanga
KJRM	Karjanagram
KJS	Krishnarajasgra
KJT	Karjat
KJTW	Kajgaon Terhwan
KJU	Kuntighat
KJUL	Kajora No.1 Colliery Sdg.
KJV	Khijadiya Jn
KJW	Khajwana
KJY	Khurja City
KJYN	New Khurja City
KJZ	Karonji
KK	Khadki
KKA	Kanki
KKAE	Kaikala
KKAH	Kankaha
KKAS	Katkamasandi
KKB	Karak Bel
KKBA	Kakbara
KKBK	Kkc Main
KKBT	KKBT Station
KKD	Kalkund
KKDE	Kurukshetra Jn
KKDI	Karaikkudi Jn
KKEC	Kankaria South Cabin
KKET	Kamrup Khetri
KKF	Kankaria
KKG	Kekatumar
KKGA	Kunkalagunta
KKGM	Kakri Guma
KKGT	Kalkalighat
KKHT	Kakarghatti Jn
KKI	Karkeli
KKJ	Kakori
KKK	Khakharia
KKL	Kala Bakra
KKLR	Kaikolur
KKLS	Kankaria Loco Shed
KKLU	Kaklur
KKM	Kamalapuram
KKMB	Kastla Kasambad
KKMI	Kerakalamatti
KKMP	Katlakunta Medipally
KKN	Khirkiya
KKNA	Khunkhuna
KKNH	Karukhirhar Nagar Halt
KKNP	Koel-Kaaro Hydro Electric Project of M/S. Nhepcl
KKNR	Kamakhya Nagar
KKP	Kot Kapura
KKPM	Kallakkudi Palanganatham
KKPR	Kokpara
KKPS	Dalmiapuram Cement Siding, Kkpm
KKQ	Kalaikunda
KKR	Khakhrala Road
KKRD	Kikakui Road
KKRH	Karahia
KKRL	Kakrala
KKRM	Kaikaram
KKRV	Kukarvada
KKRW	Kakarwa
KKS	Kurasti Kalan
KKSG	Arsenal Siding, Khadki
KKT	Kath Kuiyan
KKTA	Kollikhutaha
KKTI	Kuttakudi
KKU	Kanakpura
KKV	Kunkavav Jn
KKW	Kankavli
KKY	Kila Kadaiyam
KKZ	Kottarakara
KL	Kherli
KLA	Kulwa
KLAD	Kalanad Halt
KLAG	Kamalanga
KLAR	Kulpahar
KLAT	Kolvihir
KLB	Kiraoli
KLBA	Kalambha
KLBG	Kalaburagi
KLBN	Kalambani Budruk
KLCR	Katlichera
KLD	Khalilabad
KLDA	Kalediya
KLDI	Kaldhari
KLE	Kaithal
KLG	Kalunga
KLGA	Kalagar
KLGD	Kollengode
KLGM	Kallagam
KLGN	Kalangani
KLGR	Khalaigram
KLH	Khemli
KLHD	Kolhadi
KLI	Kauli
KLJ	Kamalganj
KLJI	Kalijai
KLK	Kalka
KLKA	Koilakuntla
KLKH	Kalladaka
KLKR	Kalikapur
KLL	Kalol
KLM	Kadlimatti
KLMC	Kalamboli
KLMD	Kollumangudi
KLMG	Kalamboli Goods
KLMI	Kalamboli Exchange Yard
KLMJ	Kalhe Majra
KLMR	Kalamasseri
KLN	Khulna
KLNA	Kolhana Halt
KLNB	Khulna
KLNC	Kullanchavadi
KLNK	Kalanaur Kalan
KLNP	Kalinarynpur Jn
KLNT	Kalinagar
KLOD	Kelod
KLP	Kotalpukur
KLPG	Kamalpur Gram
KLPM	Kailasapuram
KLQ	Kilikollur
KLRD	Kali Road
KLRE	Khalari
KLRS	Kolaras
KLS	Kolatur
KLSK	Kkc Link
KLSP	Kushalpura
KLSR	Kalasar
KLSX	Kaulseri
KLT	Kulitalai
KLTR	Kalmitar
KLU	Kalluru
KLV	Kelva Road
KLVA	Kalwa
KLVC	Kalva Emu Carshed
KLVD	Kalavad
KLVR	Kolvihir
KLW	Kulpi Flag
KLWD	Kalitalavdi
KLWL	Kilanwali Punjb
KLWN	Kalwan
KLX	Kolakalur
KLY	Kelavli
KLYG	Kalyani Ghoshpara
KLYH	Kallur Yedahli
KLYM	Kalyani Simanta
KLYN	Khileriyan
KLYS	Kalyani Silpanchal
KLYT	Kolayat
KLZ	Keolari
KM	Kalem
KMA	Kaima Jn
KMAE	Khamargachhi
KMAH	Kamathe
KMB	Kalv Amba
KMBH	Kamalabad Barhauli Halt
KMBK	Kadambankulam
KMBL	Khambhaliya
KMC	Kamareddi
KMCE	Kumar Dhubi Fire Clay & Silicon Works No.4 SDG Barakar
KMD	Kodumudi
KMDC	Kurmadanga Halt
KMDH	Kamardanga Halt
KMDR	Karimuddin Pur
KMES	Kundha Hydro Elec. SDG
KMEZ	Kumar Maranga
KMGE	Kumahu
KMGH	Kamarganj
KMH	Kalamalia
KMHN	Kamathan
KMHT	Karmahat
KMI	Kumhari
KMJ	Kaimganj
KMJE	Kumardubi Siding
KMK	Komakhan
KMKA	Kusmunda (Silo) Pvt. Sdg./Krba
KMKD	Khamkhed
KML	Kamtaul
KMLI	Kamli
KMLJ	Kamalajari
KMLM	Kelamangalam
KMLP	Kommarapudi
KMLR	Kamalur
KMM	Kannamangalam
KMMD	Kirmiti Mendha
KMME	Kumardubi
KMMS	Kerala Minerals and Metals Sdg, Karunaga Palli
KMN	Khamgaon
KMNA	Khemana
KMNC	Kuchaman City
KMND	Kumendi
KMNG	Kamranga
KMNN	Khamanon
KMNP	Kishan Manpura
KMNR	Kamalnagar
KMP	Kamlapur
KMPD	Karampada
KMPH	Kamalpur Halt
KMPR	Komarpur
KMPS	Kumarapatnam Siding
KMPT	Komati Palli
KMPU	Kamalapur
KMQ	Kumbla
KMQA	Komali
KMRA	Kamnara
KMRD	Kalamb Road
KMRJ	Kumarganj
KMRL	Kumrul
KMS	Karamnasa
KMSD	Kumar Sadra
KMSI	Kumsi
KMST	Kamshet
KMT	Khammam
KMTI	Kumarhatti
KMU	Kumbakonam
KMV	Karmad
KMX	Komati Palli
KMZ	Katni Murwara Jn
KMZA	Kankra Mirzangr
KN	Kadalundi
KNAD	Kanad
KNAG	Kanaji Halt
KNAJ	Kanaji H
KNAR	Khanpur Ahir
KNB	Kaniyambadi
KNBR	Kanaibazar
KNC	Kanchanpur Road
KNCN	Kanalus North Cabin
KND	Kandra
KNDG	Kanhadgaon P. H.
KNDI	Kandrori
KNDL	Khandel
KNDP	Khandip
KNDR	Kandari
KNDS	Khandeshwar
KNDV	Krishnadevaraya Halt
KNE	Kishanganj
KNF	Khanodih
KNG	Kathunangal
KNGK	Kakinada New Goods Complex
KNGM	Kangam
KNGN	Kanhegaon
KNGR	Kashinagar
KNGT	Karnawas
KNH	Konch
KNHE	Kanhe
KNHL	Kantenahalli H
KNHN	Kanhan Jn
KNHP	Kanhaipur
KNHR	Kirnahar
KNJ	Krishngr Cty Jn
KNJI	Karanjali Halt
KNJJ	Kannjara Halt
KNKD	Kankanadi Bypass Cabin
KNKP	Kondikoppa
KNKT	Kanakot
KNL	Kalanwali
KNLE	Kanale
KNLI	Kangali Halt
KNLP	Kanamalo Palle
KNLS	Kanalas Jn
KNM	Kanimahuli PH
KNN	Khanna
KNNA	Khinaniyan
KNNK	Kanina Khas
KNNN	New Khanna
KNNT	Kunnathur
KNO	Kundgol
KNP	Khanapur
KNPL	Kandanur Puduvayal
KNPR	Kendrapara Road
KNPS	Kendposi
KNR	Kankinara
KNRA	Kachnariakachnaria
KNRG	Kanhargaon Naka
KNRI	Kunuri
KNRN	Kanaroan
KNRT	Kuneru
KNS	Kanchausi
KNSD	New Kanchausi
KNSG	Khamaria Ordinance Factory Siding
KNSN	Karna Subarna
KNSP	Kuju New Siding
KNSR	Kanasar
KNT	Kanth
KNTR	Kanthariya
KNU	Kanjh
KNVH	Kanivehalli
KNVT	Kinwat
KNW	Khandwa Jn
KNWS	Karanwaskaranwas
KNWX	Khandwa Jn Yard
KNYR	Kaniuru Halt
KNZ	Kalanour
KNZN	New Kalanour
KO	Kosgi
KOA	Karonda
KOAA	Kolkatta Terminal
KOBL	Kechobahal Block Station
KOD	Kharaghoda
KODI	Kodi
KODN	Kodummunda
KODR	Kodinar
KOF	Marwar Kori
KOG	Konnagar
KOH	Koteshwar
KOHA	Kottakota Halt
KOHL	Kohli
KOHR	Kohir Deccan
KOI	Khodri
KOJ	Kokrajhar
KOK	Korukkupet Jn
KOKA	Koka
KOKG	Korukkupet Goods
KOL	Kolad
KOLA	Kotla
KOLE	Kole
KOLI	Kesholi
KOLR	Kolnur
KOM	Kodikkalpalaiyam
KON	Kudal Nagar
KONA	Kona
KONC	Kudal Nagar Depot
KONN	Konnur
KONY	Kisoni
KOO	Khusropur
KOP	Kolhapur
KOPR	Kopar
KOQ	Kuthur
KORA	Kora
KORI	Khori
KORL	Kural
KORU	Kopar (upper Level)
KOTA	Kota Jn
KOTI	Koti
KOTR	Korattur
KOTT	Kottur
KOU	Koduru
KOUA	Kaira Dist Coop Mil Producers Union-Anand
KOV	Kirloskarvadi
KOVD	Kolavada
KOVH	Kovvada
KOVS	Kirloskar Bros. Ltd Siding - Kirloskarvadi
KOWN	Khowang
KOX	Kachujor
KOY	Kherol
KOZ	Kosma
KP	Kamptee
KPA	Kanchrapara
KPAW	Kanchrapara Workshop Gate
KPB	Kharpokhra
KPCA	Kamarajar Port Ltd Container Terminal Private Siding
KPCC	Karnataka Power Corporation Ltd (Rtps) Siding
KPCM	Kunwarpur Chintamanpur
KPD	Katpadi Jn
KPDH	Kapurdha Halt
KPE	Kauwapur
KPFP	M/S Kesar Multimodal Logistics Ltd
KPG	Kopargaon
KPGM	Karpoorigram
KPH	Kamepalli
KPHH	Kushalpur Harnaha Halt
KPHI	Kothapalli
KPHN	Kopar Khairane
KPI	Kalpi
KPJ	Kopaganj
KPJG	Kerejanga
KPK	Kalipahari
KPKD	Khapri Kheda
KPKI	Qasimpur Kheri
KPKS	Kalipahari Colliery SDG
KPL	Kantakapalle
KPLD	Kapali Road
KPLE	Kopai
KPLH	Kotipalli
KPLL	Kotta Pndlpalli
KPLR	Koparlahar
KPM	Kumarapuram
KPN	Kuppam
KPNA	Kapan
KPO	Karanpura
KPP	Kalapipal
KPPR	Karuppur
KPPS	Kolaghat Thermal Power Station
KPQ	Kannapuram
KPRD	Kalyanpur Road
KPRJ	Kalisindh Thermal Power Project Rrvunl Siding Jhalawar
KPRK	Kandla Port Dock Rail Terminal
KPRP	Kapa Public Siding/Rsd
KPRR	Kotapar Road
KPS	Kopa Samhota
KPSH	Koderma Thermal Power Station
KPSR	Kusum Product SDG Ris
KPTM	Kanjiramittam
KPTN	Keshorai Patan
KPTO	Karanpurato
KPU	Krishnapuram
KPV	Kashipur
KPXR	Kaipada Road
KPY	Karunagappalli
KPZ	Kapren
KQA	Kondagunta
KQD	Khairatabad Dcn
KQE	Kala Akhar
KQF	Khadeen
KQI	Kalachand
KQK	Kotikulam
KQL	Kandhla
KQLS	Kamarkundu (Lower)
KQN	Kodaikanal Road
KQQ	Kaukuntla
KQR	Koderma
KQRT	Koderma Town
KQS	Kailaras
KQT	Kurgunta
KQU	Kamarkundu
KQV	Kinkhed
KQW	Kheduli
KQY	Kharikatia
KQZ	Kolar
KR	Kevedi
KRA	Karepalli
KRAI	Kahet
KRAN	Koratti Angadi
KRAP	Karapa
KRAR	Khariar Road
KRBA	Korba
KRBO	Karaboh
KRBP	Khudiram Bose Pusa
KRBR	Kerkhabari
KRBU	Kiruburu
KRC	Kiroda
KRCA	Karachiya Yard
KRCD	Kharwa Chanda
KRD	Karad
KRDH	Koradih
KRDL	Kirandul
KRDN	Karaundhana
KRDS	Koradih Thermal Power Plant Siding
KRE	Kartarpur
KRG	Koregaon
KRGA	Kuranga
KRH	Khairthal
KRHA	Korahia
KRHT	Kharahat
KRI	Khapri
KRIH	Korai Halt
KRIR	Khari Rohar Road
KRJ	Khurja Jn
KRJA	Karanja
KRJD	Karjoda
KRJL	Karanjhol
KRJN	New Khurja Jn
KRJR	Karjara
KRJT	Karanja Town
KRKD	Karakad
KRKH	Kharkara Halt
KRKM	Khara-Kameri
KRKN	Karkend
KRKP	Kyarkop
KRKR	Kurkura
KRL	Kotarlia
KRLA	Koratla
KRLG	Kotarlia Public Siding
KRLI	Kurali
KRLR	Karaila Road Jn
KRLS	Kurlasi
KRMA	Karamtola
KRMB	Karmabad Bh
KRMD	Kuarmunda
KRMG	Kumaramangalam
KRMI	Karmali
KRMP	Kumaripur Halt
KRMR	Karimnagar
KRMY	Karmaliyapura
KRND	Khorason Road
KRNG	Kargaon P. H.
KRNH	Karanahalli
KRNI	Krishnai
KRNN	Karnauti Halt
KRNR	Krishnarajnagar
KRNT	Kurnool City
KRNU	Konanur
KRO	Kurawan
KRON	Karona Halt
KRP	Krishnapur
KRPA	Khariapipra Halt
KRPB	Koraput B Cabin B. H
KRPC	Koraput A Cabin Bh
KRPN	Kharepatan Road
KRPP	Kuruppantara
KRPR	Karepur
KRPU	Koraput Jn
KRQ	Karari
KRR	Karur Jn
KRRA	Karra
KRRI	Khairranji
KRS	Karisath
KRSA	Kharsaliya
KRSH	Karamgarh Sardargarh Halt
KRSL	Krishnashilla
KRSP	Kirsadoh Railway Siding
KRSW	Kohar Singhwala
KRT	Khurahat
KRTA	Karkata
KRTH	Kiratgarh
KRTL	Kartauli
KRTN	Kirtinagar
KRTP	Kartoli Punjab
KRTR	Karota Patner
KRU	Kheralu
KRUH	Kheraundh
KRUR	Keeranur
KRV	Karavadi
KRVL	Koravangala
KRW	Kharwa
KRX	Kurud
KRXA	Khara Mp
KRXM	Krishnamohan (Halt)
KRY	Kadiri
KRYA	Kurraiya
KRYL	M/S Ramakrishi Rasayani Sdg.
KRYP	Kadiridevarapalli
KRYR	Karamsad
KRZ	Kharawar
KS	Kheta Sarai
KSA	Khasa
KSAE	Kosai
KSAG	Steel Authority of India Ltd. Siding
KSAI	Kosadi
KSAR	Kudala Sangam
KSB	Kosamba Jn
KSBG	Khusta Buzurg
KSBI	Kashiabari
KSBP	Keshabpur
KSC	Kashi Chak
KSCK	Krishnashila Chp Siding
KSCN	Kanalus South Cabin
KSD	Keshod
KSDE	Karsindhu
KSDJ	Kondey Siding
KSDK	Kusunda Colliery SDG
KSE	Kosad
KSEJ	Kosad Jn Cabin
KSER	Kosi East Sdg. Rjl
KSF	Khalispur
KSG	Kishangarh
KSGL	Karasangal
KSGN	New Kishangarh
KSH	Kali Sindh
KSHR	Keshwari
KSHT	Khetia
KSI	Kosli
KSIH	Khodseoni
KSIK	Kulapahari SDG . Pakur
KSJ	Kasganj
KSK	Kasimkota
KSLA	Kesla
KSLK	Kakinada Seaports Ltd
KSM	Kamasamudram
KSMB	Kusumbha Halt
KSN	Krishna
KSNA	Kanasar Nawada
KSNG	Kesinga
KSNK	M/S Kudgi Stpp-NTPC Siding,kudgi
KSNR	Khushal Nagar
KSNT	Brownfield Pft of Khalari Cements Limited Siding
KSO	Khemasuli
KSP	Kishanpur
KSPF	Kesoram Spun Pipe & Foundries Pvt. Ltd . Banshbaria
KSPR	Kashipura Sarar
KSQ	Kanspur Gugauli
KSR	Kasturi
KSRA	Kasara
KSRK	Kasrak Halt
KSRT	Kodanpahar,ramtek
KSTA	Kastha
KSTD	Konshet Dusaki
KSTE	Kistamsettipali
KSTH	Kashti
KSTS	Krishnamsettipalli Halt
KSU	Kustaur
KSUA	Kashipura
KSV	Kosi Kalan
KSVM	Kesavaram
KSVR	Keshav Nagar Halt
KSW	Kheri Salwa
KSWD	Kasar Wadi
KSWR	Kalmeshwar
KSX	Kotshila
KSY	Kusiargaon
KT	Kumta
KTA	Kushtala
KTAI	Kattalli
KTAL	Kathlal
KTBR	Kasturba Nagar
KTCE	Katoghan
KTCH	Kaithalkuchi
KTCR	Kottacheruvu
KTD	Kantadih
KTDA	Katuda
KTDD	Kataiya Dandi
KTE	Katni
KTES	Katni South Jn
KTF	Kot Fatteh
KTGA	Keutigua
KTGD	Koth Gangad
KTGG	Karatagi
KTGM	Kayasthagram
KTGN	Kotla Gujran
KTGO	Kotgaon P. H.
KTH	Katrasgarh
KTHA	Khutaha
KTHD	Kothari Road
KTHE	Katahri
KTHL	Kathola
KTHN	Kathoun
KTHU	Kathua
KTHY	Kalthuruthy Halt
KTI	Kanti
KTIG	Tisco SDG Kalamboli
KTJ	Khaltipur
KTJI	Katha Jori
KTK	Kyataneakeri Road
KTKA	Kotakadra
KTKD	Katangi Khurd Jn
KTKH	Kotlakheri
KTKL	Kotli Kalan
KTKR	Kumtha Khurd
KTKS	Kantakosh Halt
KTKU	Kottekad
KTLA	Katkola Jn
KTLI	Kathaltali Halt
KTLN	Khat Labana
KTLO	Kotlokotlo
KTLP	Katalpur (Halt)
KTLR	Kanthaliya Road
KTM	Kuttalam
KTMA	Kotma
KTNA	Kathana
KTNI	Kapustalni
KTNR	Kirtyanand Ngr
KTO	Katora
KTOA	Kotana
KTOR	Katoriya
KTP	Katepurna
KTPG	Kothagudem Thermal Power Station Siding For Apgenco
KTPK	Kotha Pakki
KTPM	Kotturpuram
KTPR	Kathalpukhuri
KTQ	Kudra
KTQN	New Kudra
KTR	Kothar
KTRA	Kotra
KTRD	Katosan Road
KTRH	Katareah
KTRI	Katari
KTRK	Kuturukhamar PH
KTRR	Kathara Road
KTSC	Kota South Cabin
KTSG	Katni Cement. Siding
KTSH	Kotmi Sonar Halt
KTT	Khutbav
KTTG	Tata Iron & Steel Co. Siding
KTTR	Kattur
KTTW	Kota Workshop
KTTY	Kota Yard
KTU	Kuttippuram
KTV	Kottavalasa
KTW	Kotdwara
KTWS	Kathuwas
KTWY	Kathara Washery
KTX	Katakhal Jn
KTY	Kotturu
KTYM	Kottayam
KTYR	Kottaiyur
KTZ	Khutwansa
KU	Kulikarai
KUA	Kulharia
KUB	Kasba
KUC	Karukkutty
KUCE	Kuchai
KUCH	Kuchavaram
KUD	Kudachi
KUDA	Kundapura
KUDL	Kudal
KUDN	Kudni
KUE	Kursela
KUF	Kaurha
KUG	Kusugali
KUGT	Kumar Ghat
KUH	Khachrod
KUHI	Kuhi
KUHM	Kusmahi
KUI	Kulali
KUJU	Kuju
KUK	Korukonda
KUKA	Kuka
KUKT	Kurukotta
KUL	Kallayi
KULA	Kulashekara
KULH	Kulha Halt
KUM	Kuram
KUMB	Kumarbagh
KUMM	Kumpbalam
KUMT	Kurmahat
KUMU	Kasumuru
KUN	Karnal
KUND	Kund
KUP	Kup
KUPR	Khurdpur
KUQ	Kuretha
KUR	Khurda Road Jn
KURJ	Khajuraho
KURN	Khukrana
KURO	Korari
KURT	Khurda Town
KURV	Kurwa
KUSI	Kunsi
KUT	Kanauta
KUTI	Khumtai
KUTL	Kuwanthal
KUTR	Kulathur
KUU	Kuhuri
KUV	Kundara
KUW	Kanwar
KUX	Khirsadoh Jn
KUY	Tiruppur Kulipalayam
KV	Kayavarohan
KVA	Kavas
KVC	Kaparpura
KVD	Khurmabad Road
KVDU	Kadavakuduru
KVE	Kavalande
KVG	Kuneanganj
KVGM	Kolvagram
KVH	Khambhel
KVJ	Keshavganj
KVJN	New Keshavganj
KVK	Kavathe Mahankal
KVL	Kizhvelur
KVLK	Kaval Kinaru
KVLR	Karuvalli
KVLS	Karakavalasa
KVM	Kavutaram
KVN	Kavanur
KVNJ	Kapadvanj
KVO	Kevdi Road
KVP	Kavaraippettai
KVPT	Karai-Kovilpathu
KVQ	Kosiara
KVR	Kovvur
KVS	Kalsur
KVSG	Armoured Fighting Vehicle Depot Siding, Khadki
KVT	Kunkavav Town
KVTA	Karuvatta Halt
KVU	Kadakavur
KVV	Kuravappulam
KVX	Kusumbhi
KVZ	Kavali
KW	Khervadi
KWAE	Katwa
KWAR	Kawar
KWB	Kaniwara
KWBR	Katwar Bazar
KWC	Kundwa Chainpur
KWD	Karwandia
KWDN	New Karwandiya
KWDP	Kwakdwip
KWE	Khurial
KWF	Katwa
KWGN	Kawargaon
KWH	Kachhwa Road
KWI	Kivarli
KWJ	Khojewala
KWJP	Kargali Washery Siding Pf-II
KWKC	Kherwa Kocha
KWKL	Kakri Wharfwall Siding
KWM	Kampur
KWMD	Kumbhawas Mundalia D
KWN	Kachewani
KWNI	Kawnpui
KWO	Karauta
KWP	Khatipura
KWPR	Khawaspur Halt
KWR	Koelwar
KWSC	Kawas Cabin
KWSP	Kathra Washery Siding
KWSR	Kosi West SDG ., Rajmahal
KWT	Khanalampura Wt
KWV	Kurduvadi Jn
KWW	Kuswa
KXA	Kuanriya
KXB	Kanjai
KXD	Kokalda
KXE	Kalian Chak
KXF	Kampil Road
KXG	Kharia Khangar
KXH	Kapurthala
KXI	Kurumurthi
KXJ	Karimganj Jn
KXK	Kharkhauda
KXL	Kamarbandha Ali
KXM	Kitham
KXN	Kanshbahal
KXO	Kudikadu
KXP	Kaniyapuram
KXR	Kuria
KXRA	Kuria Halt
KXT	Ketti
KXV	KXV Station
KXX	Kata Road
KXY	Kariyapattinam
KXZ	Kesariya Road
KY	Kareli
KYA	Kauriya
KYB	Kalyar
KYBR	Khairatiya Bh R
KYE	Khurai
KYF	Kajrat Nawadih
KYG	Kidiyanaga
KYH	Khairah
KYI	Kalyani
KYJ	Kayankulam Jn
KYM	Kadiyam
KYN	Kalyan Jn
KYND	Kalyandurga
KYNT	Kalyankot
KYNX	Kalyan Jn Yard (Txr)
KYO	Khandikar
KYOP	Kottapalli
KYP	Kalyanpur
KYQ	Kamakhya
KYR	Karuppatti
KYS	Kusumkasa
KYSB	Kaiyal Sedhavi BG
KYSD	Kaiyal Sedhavi
KYT	Kailahat
KYV	Koyilvenni
KYW	Karchhue
KYX	Karhiya Bhadeli
KYY	Kariha
KYZ	Kizha Puliyur
KZA	Khada
KZB	Kurumbur
KZC	Kulukkalur
KZE	Kanhangad
KZH	Kila Zafargarh
KZI	Khandrawali
KZJ	Kazipet Jn
KZJE	Kazipet E Cabin
KZJF	Kazipet F Cabin
KZJT	Kazipet Town
KZK	Kazhakuttam
KZPE	Kazipara Halt
KZPR	Kazipara
KZQ	Khimel
KZS	Kuakhera Halt
KZT	Kulitthurai
KZTW	Kulitturai West
KZU	Kunki
KZW	Katar Singhwala
KZX	Khudda Korala
KZY	Kayalpattinam
LAA	Lakhpat
LABO	Labo (Halt)
LAC	Lachhipura
LAD	Lohardaga Bs
LAE	Lakholi
LAG	Lalaghat
LAGK	GCT M/S Leap Agri Logistics (Baroda) Pvt. Ltd - Kayavarohan
LAK	Lakho
LAKN	Lakhan
LAKS	Lanco Anpara (anpara C) TPS Pvt. Sdg.
LAL	Lushala
LAN	Lotana
LANS	Lalkoti No.1 Siding
LAP	Lohapur
LAPR	Lokapur
LAR	Lalitpur
LAT	Lathi
LATH	Lath Halt
LATI	Latia Cabin
LAU	Ladnun
LAUL	Laul
LAV	Labha
LB	Laine Bazar (Halt)
LBA	Lambhua
LBD	Limbodra
LBG	Limbgaon
LBH	Dilkusha Cabin
LBI	Lilabari
LBN	Laban
LBO	Latabor
LBP	Labpur
LBPD	Lpg Bottling Plant. Durgapur
LBPM	Lpg Bottling Plant
LBT	Lalgarh Bihar Halt
LBTL	Lebutala
LBW	Laiburwa Halt
LBZ	Lalbag Bh
LC	Lucknow City
LCA	Latia Cabin
LCAB	Andal Link Cabin
LCAE	Lalbagh Crt Road
LCFD	M/S. Laxmi & Co
LCH	Linch
LCK	Lakhochak Halt
LCME	Lachhmanpur Road
LCN	Lalpur Chandra Halt
LCPS	Lodna Coke Plant Siding
LCR	Lokur
LCT	Langcholiet
LCTS	Laxmi Cement Siding (BG)
LD	Londa Jn
LDA	Lidhora Khurd
LDCY	Lodi Colony
LDD	Ladkhed
LDE	Lokdhikhera
LDH	Ludhiana Jn
LDK	Ladhuka
LDM	Ledarmer
LDP	Lodipur Bishnpr
LDR	Landaura
LDU	Lunidhar
LDVD	Laddivadi
LDW	Ladhowal
LDX	Ladda
LDY	Lakkiti
LEB	Lemuabad
LEDO	Ledo
LEK	Lakhakhera
LER	Lehra
LFG	Lower Haflong
LFSG	M/S. Nuvoco Vistas Corporation Ltd Served By Gambhiri Road
LGB	Lohgarh Abub
LGCE	Lagargawan
LGD	Lallaguda
LGDH	Lalaguda Gate
LGH	Lalgarh Jn
LGI	Langal
LGL	Lalgola
LGN	Lehgaon
LGO	Lalgopalganj
LGRE	Lingiri
LGT	Langting
LGTR	Lingaraj Tmp Road
LH	Lahing
LHA	Lehra Gaga
LHB	Lahabon
LHBK	Lothal Bhurkhi
LHD	Lohogad
LHK	Laihra Khana
LHL	Lahoal
LHLL	Lahli
LHM	Lehra Muhabbat
LHN	Lachyan
LHNA	Lohanda Halt
LHNR	Lakshmanpur Halt
LHU	Loharu
LHW	Loharwara
LIG	Linga
LIJ	Lakshmiganj
LIKA	Laikera
LIL	Lilma
LILG	Lipton India Ltd Siding
LIM	Sonalium
LIN	Lingamguntla
LING	Ling
LIOC	IOC Siding, Lku
LIPL	M/S. Nuvoco Vistas Corporation Ltd. Served By Akaltara
LIR	Lachmipur
LJN	Lucknow Junction
LJO	Longrangajao
LJR	Lanjigarh Road
LKA	Lanka
LKB	Lakshmipur Bhorang
LKBL	Lakhabawal
LKCB	Lajkura Cabin
LKD	Lakodara
LKDM	Lakdaram
LKDU	Lankalakoderu
LKE	Lakheri
LKES	ACC Limitd, Lakheri
LKF	Lake Gardens
LKG	Lamsakhang
LKJN	Link Jn Cabin
LKK	Lyallpur Kc Hlt
LKKD	Lakkad Kot
LKMN	Lokmanya Nagar
LKMR	Lakshmipur Road
LKN	Lakhminia
LKNA	Lakhna
LKNR	Lakhpat Nagar
LKO	Lucknow Charbagh
LKOY	Lucknow Yard
LKPL	Lakdi ka Pul
LKPR	Lakshmikantpur
LKQ	Laukaha Bazar
LKR	Luckeesarai Jn
LKS	Lunkaransar
LKSH	L Narayanapuram
LKT	Hulkoti
LKU	Lalkua Jn
LKW	Lakhewali
LKX	Lakshmipur
LKY	Lakhmapur
LKZ	Lakadiya
LLBR	Lalabazar
LLCR	Lalmatia Loading Complex (rajmahal Area)
LLD	Lalavadi
LLGM	Leligumma
LLH	Liluah
LLHW	Liluah Workshop
LLI	Lalgudi
LLJ	Lalganj
LLJP	Lalganj Pakri
LLKN	Lal Kalan
LLP	Lalitgram
LLPR	Lalit Lakshmipur
LLR	Lalpur
LLST	Lalsot
LLTG	Lalitagiri
LLU	Lalru
LM	Limbdi
LMA	Lambiya
LMB	Limbara
LMC	Lakhamanchi
LMD	Linganenidoddi
LMG	Lumding Jn
LMGB	Locm Rapid Loading System
LMGF	Lumding Jn (MG)
LMGS	Lumding South Cabin
LMGT	Private Siding, Lingaraj MGR of M/S MCL At Talcher
LMK	Limkheda
LMM	Lailakh Mamlkha
LMN	Lachhmanpur
LMNR	Lakshmibai Ngr
LMO	Liliya Mota
LMP	Lakhimpur
LMT	Almatti
LMU	Limarua
LMY	Laimekuri
LNA	Lamana
LNBI	Linganabandi
LNH	Lachhman Garh Sikar
LNJ	Langhnaj
LNK	Lohian Khas Jn
LNKB	LNKB Station
LNKC	Link C-Cabin
LNL	Lonavala
LNLA	Lanela
LNLX	Lonavala Yard
LNMA	Lakhan Majra Halt
LNN	Lonand
LNO	Lohna Road
LNP	Langarpeth
LNQ	Lakhnauria
LNR	Luni Richha
LNS	Lunsu Halt
LNT	Lingti
LNV	Lunavada
LNW	Lakhanwara P. H.
LNWT	Lko Alambagh W Cabin
LNX	Special Railway Siding Lalnagar
LO	Loliya
LOA	Lorha
LOCM	Lajkura Open Cast Mines III
LOD	Lekoda
LOG	Lohgara
LOGH	Lottegollahalli
LOHA	Loha
LOK	Loknath
LOL	Loliem
LOM	Lodhma
LOMB	M/S Lajkura Open Cast Mines I
LOMC	M/S Lajkura Open Cast Mines I I
LONI	Loni
LOT	Lohta
LOV	Lovedale
LP	Lalapet
LPA	Latipura
LPBG	Lpg BPCL Siding Bhitoni
LPBP	Lpg Bottling Plant, Llu
LPBS	IOC Ltd Lpc Bottling Plant SDG
LPDC	Ltc Plant Dankuni Coal Complex SDG ., Janai Road
LPG	Lapanga
LPGC	LPGC Station
LPGK	Lpg Bottling Plant Siding , Panki
LPGS	Lpg Siding (IOC) Shirva
LPGU	Lalitpur Power Generation Company Limited
LPH	Lotapahar
LPI	Lingampalli
LPJ	Lalpur Jam
LPJL	Lingampet Jagityal
LPK	Lepetkata
LPN	Laopani
LPNC	Lajpat Nagar Bypass A Cabin
LPNR	Lajpat Nagar
LPR	Lilapur Road
LPSG	L P. G. Bottling Plantsiding For Hindustan
LPTA	Longpatia
LPU	Lakhpuri
LPW	Loharpurwa
LR	Ladpura
LRA	Lodra
LRB	Larabad
LRD	Lar Road
LRI	Lihuri
LRJ	Laksar Jn
LRJC	Laksar North Cabin
LRNC	Laksar North Cabin
LRST	Lingaraj Spur Siding No.3 of MCL
LRU	Lalpur Umri
LS	Lasalgaon
LSD	Lusadiya
LSE	Laseri
LSG	Lawa Sardargarh
LSGS	Lavan Satyagraha Smarak P. H
LSI	Laheria Sarai
LSMP	Laxmapur
LSN	Lasina
LSR	Lasur
LSST	Lingaraj Silo Siding of M/S MCL
LSX	Loisingha
LT	Lahavit
LTA	Lamta
LTBK	Line No.10, Barkakana
LTC	Low Temperature Carbonisation Plant Colliery Siding
LTD	Lathidad
LTG	Lataguri Jn
LTHR	Latehar
LTI	Latteri
LTK	Lathikata
LTKR	Lalit Khera Halt
LTMD	Latemda
LTR	Lakhtar
LTRR	Latur Road
LTSK	M/S Larson & Toubro, Kansbahal
LTT	Mumbai LTT
LTV	Lotarva
LUA	Laluri Khera
LUBA	Lachhubigha Halt
LUN	Lavanpur
LUNI	Luni Jn
LUR	Latur
LUSA	Lusa
LVCP	Liberty Victory Colliery Siding
LVK	Lakkavarapukota Halt
LVR	Lokvidyapth Ngr
LW	Lorwada
LWJ	Lowjee
LWR	Alnavar Jn
LWS	Lukwasa
LXA	Lakswa
LXD	Lakshannath Road
LXMP	Lakshmipur Bihar
LXR	Lunseriya
LYD	Layabad
MA	Madha
MAA	Maval
MAAL	Pvt SDG of M/S HINDALCO Industries Ltd,unit-Aditya Aluminium
MAAM	M/S Adani Agro Logistics Ltd. Private Siding At Malur
MAAP	Adani Agri Logistics Ltd
MAAR	Malhar
MABA	Mandi Bamora
MABB	Mabbi Halt
MABD	Mahbubabad
MABG	Matana Buzurg
MABM	Mab Dham (Akbarganj)
MABN	Maban
MAC	Machiyala
MACH	Moula Ali Hb Colony Halt
MACI	Maranchi Halt
MACR	Manguli Chowdwar
MACU	Mellacheruvu
MAD	Maddur
MADA	Maonda
MADM	Matradham
MADP	Madhapur Road
MADR	Madure
MADU	Madduru
MAE	Matheran
MAEL	Mael
MAF	Manavur
MAG	Mangalagiri
MAGH	Manikgarh
MAGN	Mahagaon
MAH	Madhoganj
MAHA	Murahara
MAHE	Mahe
MAHI	Mahipur
MAHM	Meham
MAHO	Maholi
MAI	Mehsi
MAIL	Pft of M/S Aryan Ispat & Power Pvt Ltd
MAJ	Majhergram
MAJN	Mangalore Jn
MAK	Mallikpur
MAKG	Maulkhang
MAKH	Mokhampura
MAKM	Mararikulam
MAKP	Manikpura
MAKR	Bina Malkheri Jn
MAKU	Mspl-Ahb Sidings
MALA	Mala
MALB	Maliya Miyana Jn
MALK	Malkapur Road
MALM	Manthralayam Road
MALR	Mallur
MALX	Maliyamiyana
MAM	Mangal Mahudi
MAMC	Mamc Private Siding
MAMM	M/S Ambuja Cement Ltd GCT Served By Marwar Mundwa
MAMN	New Maman
MAN	Maninagar
MANA	Mana
MAND	Mandurai
MANE	Maneswar
MANG	Mahanagar
MANI	Mani Halt
MANK	Manki
MANR	Mansarovar
MANU	Manu
MANW	Manwa
MAO	Madgaon Jn
MAP	Morappur
MAPA	Makkapeta (crossing Stn)
MAPD	M/S Adani Petronet (Dahej) Port Limited
MAPI	Muktaposi
MAPT	M/S ACC Limited Private Siding Served By Thondebhavi Station
MAQ	Mangalore Central
MAR	Mulanur
MARD	Mavur Road
MAS	MGR Chennai Central
MASK	Maisar Khana
MASS	Chennai Central Suburban
MATL	Matla Halt
MATP	Associated Container Terminal Ltd Asaoti
MAU	Mau Jn
MAUL	Mauli Block Hut
MAUR	Maur
MAV	Mariammankovil
MAVB	Private Siding of M/S Vedanta Limited
MAX	Mangudi
MAY	Mariahu
MAYA	Makakhad
MAYP	Mayapur
MAYR	Mayar
MAZ	Mangra
MB	Moradabad
MBA	Mahoba
MBAH	Mirabigha Halt
MBB	Murshidabad
MBBC	Mngt New Byepass
MBC	Mahananda Bge
MBCB	Ballarpur Colliery Sdg.
MBCY	M/S. Bharathi Cements Corporation Limited
MBD	Mustabada
MBDD	Mbdd Dandupur
MBDP	Maa Belha Devi Dham Pratapgarh Jn
MBE	Mirzapur Bankipur
MBEB	Pvt. Siding of M/S. Bengal Energy Pvt. Ltd.
MBF	Munabao
MBG	Maibang
MBGA	Marwar Bagra
MBGC	M/S Mbr Silos Private Ltd.
MBH	Mobha Road
MBI	Madhubani
MBIJ	Ballarpur Industries Siding
MBIV	Bmm Ispat Ltd Siding
MBL	Manubolu
MBLP	Maharaja Bijli Pasi (Nihalgarh)
MBM	Mambalam
MBMB	Private Siding of M/S Tata Steel Limited
MBNL	Marwar Bhinmal
MBNO	Military Siding Banar
MBNR	Mahbubnagar
MBO	Mairabari
MBP	Mohibullapur
MBPB	M/S Shri Bajrang Power & Ispat Ltd SDG
MBPC	Bina Despatch Terminal: BPCL Siding
MBPG	M/S. Bharat Petroleum Corporation Ltd,sdg Served By Gooty Stn
MBPJ	M/S. M B Power (madhya Pradesh) Limited
MBPP	BPCL Sdg. At Uran
MBQ	Mumbra
MBS	Madhosingh
MBSH	M/S Ultratech Cement Ltd.
MBSJ	M/S Bharat Starch Industries, Jagadhri
MBSK	Marwar Balia
MBT	Marwar Bithri
MBU	Melpattam Bakkam
MBV	Mirzapur Bachhod
MBW	Malwara
MBWC	Moradabad West Cabin
MBWK	Madhubandh Washery
MBY	Mandi Dabwali
MC	Mandapam Camp
MCA	Mecheda
MCAC	Military Ramp Siding, Ambala Cantt
MCBB	M Cabin/Bley
MCCM	Mumbai Central Emu Carshed
MCCS	Ultra Tech Cement Limited (unit: Sonar Bangla Cement Works)
MCDA	Mcdd Antu
MCES	M/S Cesc Power Generating Station Budge Budge
MCF	Manik Chowree P. H.
MCFK	M/S Chidambara Chemicals & Fertilizers Ltd
MCFL	Private Siding of M/S Mahanadi Coalfields Limited At Laikera
MCHV	Mechanized Cargo Handling Terminal of Visakhapatnam Port Authority
MCI	Mancheral
MCJ	Manjattidal
MCK	Manikpur Colliery Siding
MCKG	Mouza Colliery Siding
MCL	Madimangalam
MCLA	Macherla
MCLB	MCL Block Cabin
MCLE	Manchili
MCLJ	Madras Cements Ltd
MCLK	Konika Siding of MCL
MCN	Mukundarayapurm
MCNP	Maratha Cement Works Ltd
MCO	Motihari Court
MCPE	Marwar Chapri
MCPK	Chepauk
MCPT	Chintadaripet
MCQ	Mirchadhori
MCRD	Mecheri Road
MCS	Mancheswar
MCSC	Maharaja Chhatrasal Station Chhatarpur
MCSG	Manchiryal Cement Co. Siding/Manchiryal
MCSI	JSW Steel Ltd Siding
MCSK	Maheshpur Colliery Siding
MCSP	Pure Jambad A Colly. SDG
MCSU	V. K . Asstt SDG
MCTM	MCTM Udhampur
MCTP	Mangalore Coal Terminal Pvt. Ltd. Siding Served By Panamburu
MCTS	Mangalam Cement Ltd Mkx
MCU	Mulacalacheruvu
MCV	Macharya
MCVM	Machavaram
MCWH	Central Warehousing Corporation
MCY	Machriawan
MCYA	Mills Railway Siding Lehreagaga
MCZ	Mahabuang
MD	Madar
MDA	Mandhana Jn
MDAD	Adani Agri Logistics Sdg, Madukkarai
MDAK	Medak
MDAR	Mundra Airport Road (BG)
MDB	Mandor
MDBI	Mandarbani Colliery SDG
MDBP	Madhabpur
MDC	Makardaha
MDCC	Mundra Port Cargo Complex
MDCJ	M/S. Deccan Cements Ltd
MDCR	Masaudhi Court Halt
MDCS	M/S. Dalmia Cements (Bharat) Limited
MDD	Malad
MDDG	Malad Gaon
MDDP	Mandi Dip
MDE	Makhdumpur Gaya
MDF	Muradi
MDG	Mandal Ghat
MDGB	Madhabnagar Halt
MDGR	Manendragarh
MDH	Mandhar
MDHA	Madhada
MDHI	Madhaipur Colliery Sdg.
MDIT	Dhariwal Infrastrutre Ltd Siding
MDJ	Muhammadganj
MDJN	Madar Jn
MDKD	Madhukunda
MDKI	Madukarai
MDKM	Madattukulam
MDKS	Associated Cement Co. Ltd Siding-Madukarai
MDKU	Modukuru
MDL	Mandal
MDLA	Mundlana
MDLE	Mandar Hill
MDLL	Muddalingahalli
MDLM	Mundalaram
MDMD	Mahadeiya Line No.5
MDN	Midnapore
MDNR	Modinagar
MDP	Madhupur Jn
MDPA	Mandpiya
MDPB	Madhopur Punjab
MDPC	Mundra Portcontainer Terminal
MDPD	Mandapadu
MDPJ	Madanapur Halt
MDPR	Modpur
MDPT	Mundra Port R & D Yard
MDR	Madhira
MDRA	Medra
MDRR	Madhavnagar Road
MDS	Mandasor
MDSA	Modasa
MDSB	Military Ramp Siding, Bhatinda
MDSE	Madhu Sudanpur
MDSP	Pathankot Military Siding
MDST	Mother Dairy Siding
MDT	Madarihat
MDU	Madurai Jn
MDUN	Madhranagar
MDVB	Mandar Vidyapith Halt
MDVE	Mahendravadi
MDVK	Mahadeokhedi
MDVL	Mandavalli
MDVR	Madhavnagar
MDW	Marwar Mundwa
MDWI	Mandawari
MDXR	Mudaria
ME	Masaipet
MEBK	M/S Mpeb Siding, Krba
MEC	Merta City
MECB	M/S. Earth Minerals Company Ltd.
MED	Medchal
MEE	Methai
MEG	Meleng
MEGN	Mehgaon
MEH	Melalathur
MEJ	Vanchi Maniyachchi Jn
MEKM	Melakkonnakkulm
MEL	Marine Lines
MELG	Maharashtra Electrosmelt Siding
MELH	Melusar
MEM	Mau Aimma
MENP	Meenapur
MEP	Mahidpur Road
MEQ	Malethu Kanak
MER	Metpanjra
MES	Madurai East
MESR	Mesra
MET	Malerkotla
METR	Methi Tikur
MEU	Mendu
MEW	Marhaura
MEX	Mukerian
MFA	Mukuria
MFB	Mustafabad
MFC	Monabari
MFCK	Mustapha Chak
MFCP	Matix Fertilisers & Chemicals Ltd
MFCS	FCI Siding Karnal
MFGT	M/S. FCI of Govt. Food Grain Godown
MFH	Mahrauli
MFJ	Muftiganj
MFKA	Musafir Khana
MFL	Misrauli
MFM	Mahalam
MFP	Muzaffarpur Jn
MFPB	Private Siding of M/S Ferro Alloys Corporation Ltd
MFQ	Mahroi
MFR	Mandla Fort
MFSG	Maharashtra State Electricity Board Siding Bsl
MFSJ	M/S Mahanadi Coalfield Ltd. At Sardega
MFX	Madaraha
MFZ	Malahar
MG	Modelgram
MGAE	Morgram
MGB	Mudigubba
MGBK	Private Siding of M/S Gmr Kamalanga Energy Ltd
MGC	Mugat
MGCH	Pvt. Siding of M/S. Ultratech Cement Limited
MGCS	Maharashtra Gas Craker Complex SDG
MGCT	Private Siding of M/S Global Coal & Mining Pvt. Ltd.
MGD	Mugad
MGDR	Magardarra
MGE	Migrendisa
MGF	Mandagere
MGG	Mangliya Gaon
MGHP	Meghpur
MGI	Manigachi
MGIS	M/S Gallantt Ispat Ltd, Siding,sahjanwa
MGK	Mulagunnathukavu
MGKM	Mungiyakami
MGKP	Manisingh ka Pura
MGKS	Food Corporation of India Grains Godown (b. G.) Sdg, Mgk
MGL	Mugalalli Halt
MGLE	Manigram
MGLI	Mangli Halt
MGLP	Mangolpuri
MGM	Muragacha
MGMA	Global Coal and Mining Pvt Ltd
MGME	Mccluskieganj
MGMT	M/S Adani Power Ltd.
MGMY	Mughal Sarai Marshalling Yard
MGN	Meghnagar
MGO	Mahisgaon
MGPA	Munda Gopal Ash
MGPI	Mangarpatti Halt
MGPM	Mangapuram
MGPR	Mangampet Road
MGPV	M/S Adani Gangavaram Port Pvt Ltd
MGR	Monghyr
MGRD	Magardoh
MGRL	Mangrolla
MGRP	Megh Raj Pura
MGRR	Magarpur
MGSF	Gun & Shell Fy. SDG Cossipore Road
MGSJ	Magnesite Jn
MGSO	Mughal Sarai Outer Cabin
MGSP	M/S. Grasim Industries Limited
MGT	Magrahat
MGTD	Meghpur Titodi
MGV	Molagavalli
MGVK	Malegaon Vyenku
MGW	Magarwara
MGWD	Mahngarwl Doaba
MGWN	Mahgawan Halt
MGX	Mailongdisa
MGZ	Maharaj Ganj
MH	Mahuri Halt
MHA	Marahra
MHAD	Mohadi Prgn Lng
MHBA	Mathabhanga
MHBD	Mohanbari
MHBG	Mahadeva Buzrug
MHBS	M/S HPCL & BPCL (assited Cum Private) SDG
MHBT	Mahbub Nagar Town Ha
MHBZ	Mahtha Bazar
MHC	Masrakh
MHD	Mahemadavad Kheda Road
MHDA	Mahdeiya
MHDB	Mahadia PH
MHDP	Mahadevpara
MHF	Mohari
MHH	Maghar
MHHR	Mahesra
MHI	Manihari
MHJ	Mahajan
MHJA	M/S Hukumchand Jute Mill SDG
MHKT	Mohkhuti
MHL	Mahwal
MHLC	Monkey Hill
MHLN	Mahendralalnagar PH
MHLT	Mahesh Leta Halt
MHMB	Mahimba
MHN	Mahanadi
MHNR	Mahesh Nagar Halt
MHO	Mahpur
MHOW	Mhow
MHP	Muhammadpur
MHPE	Mhope
MHPL	M/S Hasti Petro Chemical & Shipping Ltd At Sanand
MHPR	Mahiyarpur
MHQ	Mohuda
MHRG	Mahendragarh
MHRI	Machhrauli
MHRL	Mahrail
MHRN	Mahendranath
MHSA	Maheshpur
MHSP	Mahespur
MHT	Manjhi F
MHTR	Malihati Tbr Road
MHU	Manheru
MHUA	Mahudha
MHUL	Mehuwala Halt
MHUR	Mohanpur
MHV	Mahuva Jn
MHWL	Machrowar
MHZR	M/S Hindustan Zinc Ltd Siding
MIA	Mania
MIAL	Milavali Halt
MIAN	Miangram
MIB	Motibagh
MICB	M/S I O C 32 SDG . S/B Budge Budge
MICL	Mico Users Tex Maco SDG
MICT	The India Cements Limited
MID	Madhi
MIDH	Malidih Block Station
MIDP	Mamidipalli
MIG	Midghat
MIGK	Indira Gandhi Super Thermal Power Project Served Bysudharana
MIH	Mihrawan
MIHK	M/S IOC Siding Hazira Kosad
MIJ	Majhdia
MIK	Manikui
MIKD	Mahikhand Halt
MIL	Milak
MILA	Milakpur Halt
MILE	Mile 5b Cabin
MILK	M/S Central Warehousing Corporation.
MILS	Modern Industries Ltd Siding
MIM	Maniram
MIMH	M/S Mivaan Steels Limited
MIN	Mihinpurwa
MINA	Miyana
MINJ	Maikalganj
MIO	Molisar
MIOJ	M/S Indianoil Adani Ventures Ltd.
MIPM	Marri Palem Halt
MIPR	M/S Indian Petro Chemicals Corp. Ltd Sdg, Ranoli
MIPV	The India Cements Limited.
MIQ	Mirhakur
MIR	Maijapur
MIRA	Mira Road
MISB	M/S. Indian Standard Wagon Co. Ltd.
MISY	Maraphari Stock Yard of M/S. Bsl
MITA	Mitha
MIU	Maripat
MIVB	M/S. Vimla Infr. Ind. Pvt. Ltd.
MIW	Mighauna
MIX	Manipuram Cabin
MIYN	Maniyan
MJ	Marwar Jn
MJA	Meja Road
MJAC	M/S Dalmia Cement (Bharat) Limited, Chunar
MJBB	M/S Jai Balaji Industries Ltd
MJBK	Manjari Budruk
MJBM	Pvt SDG of M/S Jai Balaji Indst Ltd
MJBT	Majbat
MJCG	M/S. J K Cement Works Ltd SDG
MJE	Mujnai
MJF	Malkajgiri
MJG	Majhagawan
MJGP	Majhgawan Phatak
MJH	Maju PH
MJHL	Majada Halt
MJHR	Majhiari
MJKN	Majri Khadan
MJL	Majhowalia
MJM	Manjhauligram Halt
MJMG	Marwar Jn (MG)
MJMK	Jindal Infrastructure Ltd.-Siding
MJN	Makum Jn
MJND	New Marwar
MJNL	Majri Nangal
MJNS	Maa Jagdamba Nawada Halt
MJO	Majorda Jn
MJOG	Jubilant Ingrevia Limited
MJP	Moharajpur
MJPB	Manjhra Purab
MJPJ	Ms Jhajjar Power Ltd SDG Served By Jharli
MJR	Minjur
MJRI	Majri Jn
MJS	Manjeshwar
MJSG	New Manjri Colliery Siding, Majri Jn
MJT	Majerhat
MJTA	Majitha
MJV	Manjhagarh
MJY	Maramjhiri
MJZ	Majhola Pakarya
MK	Miranpur Katra
MKA	Mokama
MKAK	Mundaka Kanni Amman Koil
MKB	Mankatha
MKBH	Manwala Kot Bak
MKBN	Mukutban
MKC	Maksi Jn
MKCW	Kartikeya Coal Washery Sdg.
MKD	Markundi
MKDD	Mukundwadi Halt
MKDI	Makudi
MKDM	Maa Kalikan Dham (Mishrauli)
MKDN	Markadhana
MKFP	M/S Kanpur Fertilizers & Chemicals Limited (kfcl),panki
MKG	Manak Nagar
MKGD	Manikagoda
MKH	Malakhera
MKHI	Makhi
MKHR	Marwar Khara
MKHS	Mokar Halt
MKIG	M/S KRIBHCO Infrastructure Ltd Siding Served By Gothangaon
MKIK	M/S KRIBHCO Infrastructure Ltd Siding Served By Kosad
MKJ	Makkajipalli
MKK	Kodambakkam
MKL	Makalidurga
MKLI	Makrauli
MKM	Marikuppam
MKMA	M/S JSW Mahanadi Power Compnay Limited
MKMN	Mokhra-Madina
MKN	Makrana Jn
MKO	Markona
MKP	Manikpur Jn
MKPG	M/S Kalyani Steel Ltd Siding
MKPP	M/S Kanpur Logistics Park Private Limited
MKPR	Muktapur
MKPT	Malikpeth
MKR	Maddikera
MKRA	Makrera
MKRD	Machhakunda
MKRH	Mallichpurhat
MKRL	Moti Koral
MKRN	Makronia
MKS	Muktsar
MKSG	Military Transit SDG Mankhurd
MKSP	Mukhasa Parur
MKSR	Mokalsar
MKT	Mukhtiar Balwar
MKTL	Makthal
MKTP	Muketashwar
MKU	Malkapur
MKWI	Makarwadi Halt
MKX	Morak
MKY	Mekkudi
MKZ	Mahkepar Road P. H.
ML	Malhour
MLAR	Malanpur
MLB	Modlimb
MLBN	Mohalboni
MLBZ	Mal Bazar
MLC	Malkisar
MLD	Malihabad
MLDE	Madlauda
MLDR	Melamarudur
MLDT	Malda Town
MLFC	Malda Court
MLG	Malhargarh
MLGC	M/S Mpl Logistics Hub Private Limited
MLGH	Mandal Garh
MLGT	Mallappa Gate
MLH	Manaklao
MLHA	Maliya Hatina
MLHS	Light House
MLI	Mangaliyawas
MLIH	Mauli Halt
MLJ	Mohanlalganj
MLK	Malkapuram
MLKA	Maluka
MLKH	Mulewal Khaihra
MLKN	Mundhal Kalan
MLKP	Malikpur
MLLT	Ultra Tech Cement Ltd Siding, Arakkonam
MLM	Malthan
MLMD	Mahadeiya Line No.4
MLMG	Mallemadugu
MLMI	Mal Mohari
MLMR	Melmaruvathur
MLN	Mailani
MLND	Mulund
MLNH	Malancha
MLNM	Mailani (MG)
MLNR	Gawada Malosan
MLO	Malur
MLP	Mallapur
MLPB	Multimodal Logistics Park Balli
MLPM	Melpakkam
MLPR	Malipur
MLQ	Malkera Jn
MLR	Malkhed
MLS	Malasa
MLSA	Mallasandra
MLSR	Malsar
MLSU	Malsailu
MLSW	M/S Evonith Value Steel Ltd.
MLT	Malatipatpur
MLTC	M/S Ultra Tech Cement Limited.
MLTI	Malti
MLTR	Melattur
MLU	Malugur
MLV	Mallarpur
MLVM	Molvom
MLW	Mallanwan
MLX	Mullanpur
MLY	Maula Ali
MLYA	Maliya Halt
MLYC	Moulali C Cabin
MLYG	Moula Ali G Cabin
MLYR	Melnariyapanur
MLZ	Malarna
MM	Bmby Mahim Jn
MMA	Muhammadabad
MMB	Mahmudabad Avdh
MMBD	Maheshwari Coal Beneficiation & Infra Pvt Ltd
MMBP	Manoharpur Mines Siding of Opgc/Bph
MMC	Mahamandir
MMCA	Amoni Workshop
MMCT	Mumbai Central
MMD	Maheshmunda
MMDA	Muthalamada
MMDL	Mohini Mandal (Halt)
MMDP	Mohamadpur
MME	Mul Marora
MMEC	M/S, Mineral Enterprises Ltd.
MMG	Madhyamgram
MMH	Mahadanapuram
MMHM	M/S. My Home Industries Private Limited
MMHR	M/S. My Home Industries Private Limited
MMI	Mariyamanahalli
MMIS	M/S Mid East Integrated Steels Ltd
MMK	Madurantakam
MMKB	Mekra Memerkhabad Halt
MML	Madan Mahal
MMLN	Mahuamilan
MMM	Mandapam
MMMT	Maithon Power Limited SDG
MMNK	Maraimalai Nagar Kamarajar
MMP	Mambalappattu
MMPL	Mantapampalle
MMPR	Mamdapur
MMR	Manmad Jn
MMRB	Manmad B Cabin
MMRC	Minerals and Minerals SDG
MMRT	M/S Mrpl Siding
MMRX	Manmad Jn Yard (Txr)
MMS	Mandasa Road
MMSS	Malvika Steel Ltd
MMU	Mugma
MMV	Mahali Marup
MMVR	Murga Mahadev Road
MMY	Marwar Mathaniya
MMZ	Mandamari
MN	Minambakkam
MNAE	Mankar
MNAP	Matnia Anantapur
MNBK	M/S. NTPC-SAIL Power Co. Pvt.ltd
MNC	Madankata
MNCK	M/S. Nagarjuna Cements Limited Siding
MNCR	Monacherra
MND	Munderwa
MNDA	Mandura
MNDH	Mandir Hasaud
MNDK	Maganoor
MNDP	Mendipathar
MNDR	Mandi Dhanaura
MNDU	Mandu Halt
MNDV	Mandawariya
MNDY	Mandaveli
MNE	Mansi Jn
MNF	Manda Road
MNGD	Muniguda
MNGR	Mohan Nagar
MNGT	Mysore New Goods Terminal
MNGV	Mota-Miya-Mangrol
MNH	Munshirhat PH
MNHA	Mindha
MNHL	Majhairan Hmchl
MNI	Mangaon
MNJ	Manoharganj
MNJR	Manjhlepur
MNKB	Miyan ka Bara Halt
MNKD	Mankhurd
MNKH	Maranayakanahalli
MNKN	Manikalan Halt
MNKR	Mallankinar
MNKT	MGR Unloading Point of NTPC/Kaniha
MNL	Minchnal
MNLI	Manali Halt
MNM	Manamadurai Jn
MNMA	Mandan Mishra
MNME	Manamadurai East
MNMU	Mani Mau
MNO	Mehnar Road
MNP	Mananpur
MNPR	Mianpur
MNPT	Mungilipattu
MNQ	Mainpuri
MNR	Makkhanpur
MNRN	New Makkhanpur
MNS	Manshahi
MNSG	Majri Old Sdg, Majrikhadan
MNSK	Nalwa Steel & Power Ltd SDG
MNSM	Manikgarh New Goods Shed
MNSR	Manaksar
MNTT	Mulanturutti
MNU	Mundikota
MNUR	Mannanur
MNV	Mungaoli
MNVG	Navbharat Ventures Ltd
MNVL	Manwal
MNWL	Manwal
MNX	Manganallur
MNY	Mankarai
MNZ	Manani
MO	Mohol
MOA	Manopad
MOAR	Monipur Bagan
MOB	Manoharabad
MOBD	Moabund
MOCB	M/S Oblapuram Mining Company Ltd Siding
MOCL	Pvt. SDG of M/S Dalmia Cement (Bharat) Ltd.
MOD	Morampudi
MOF	Mondh
MOG	Mohiuddinnagar
MOGA	Moga
MOH	Mohisila
MOHR	Mohana Haryana
MOI	Mori Bera
MOIB	Private Siding of M/S Dalmia Cement (Bharat) Limited
MOIL	Bharwali Manganize Ore Siding
MOJ	Mohana
MOL	Muli Road
MOLK	Molakarampatti
MOM	Maman
MOMB	M/S. Orissa Mining Corpn.
MOMG	Gati Shakti Multi-Modal Cargo Terminal of M/S. Orissa Metaliks Pvt. Lt
MOMN	Pvt. Sdg. of M/S. Orissa Metaliks Pvt. Ltd. (at Nimpura-Gokulpur)
MOMU	Molakalmuru
MON	Modran
MONJ	Monglajhora
MONR	Mohanur
MOO	Muddanuru
MOP	Mohitnagar
MOPR	Mohanpura
MOR	Mor
MORA	Moraiya
MORY	Moriya
MOT	Malout
MOTA	Mota
MOTC	Motichur
MOTG	Motiganj
MOTH	Moth
MOU	Manoharpur
MOW	Mananwala
MOX	Moran
MOY	Mohri
MOZ	Muzaffarnagar
MOZN	New Muzaffar Nagar
MP	Melappalaiyam
MPA	Manaparai
MPBG	Mpeb Sdg.
MPC	Muttampatti
MPCJ	M/S Penna Cements Industries Ltd
MPCL	BPCL Pvt BG Siding
MPCS	Mysore Petro Chemicals Ltd Siding
MPCT	M/S. Penna Cement Industries Limited Served By Tandur
MPD	Madpur
MPE	Malatipur
MPF	Muirpur Road
MPG	Manpur Nagaria
MPGC	Mrb Patiala Storage Private Ltd.
MPH	Mundha Pande
MPI	Melpatti
MPIB	M/S Pristine Magadh Infrastucture Pvt. Ltd.
MPJ	Madanpur
MPJM	M/S Madhya Pradesh Jaypee Minerals Ltd.
MPJP	M/S. Penna Cements Limited
MPK	Chennai Park
MPKT	Chennai Park Town
MPL	Madanapalle Road
MPLE	Mahipal
MPLI	Minnampalli
MPLM	Murthipalaiyam
MPLR	Mahipal Road
MPLY	Meppuliyur
MPM	Muktapuram
MPML	Mohapani Mal
MPN	Madhyampur
MPNH	Majnupur Navada Halt
MPO	Manpur Jn
MPR	Makar Pura
MPRA	Mahammad Pur
MPRD	Mathurapur Road
MPRN	New Makarpura Jn
MPT	Mangalampeta
MPU	Medapadu
MPUE	Mainpuri Kachri
MPUR	New Madanpur
MPX	Merpanaikkadu
MPY	Murarpur
MQ	Mannargudi
MQA	Matoda
MQC	Mundka
MQE	Mohammadkhera
MQG	Milangarh
MQJ	Maradam Halt
MQL	Mirkhal
MQN	Manyamkonda
MQO	Munroturuttu
MQP	Makrandpur
MQQ	Markahandi U Ht
MQR	Malkhaid Road
MQS	Malsian Shahkht
MQSF	Firozpur Cantt Quila Siding
MQSG	Maharashtra State Electricity Boards Siding Odha
MQU	Murukkampuzha
MQW	Mallannagar
MQX	Meralgram
MQZ	Mota Jadra
MR	Martur
MRA	Morena
MRB	Munirabad
MRBD	Moinarband
MRBL	Muribahal
MRBS	Military Ramp Siding, Bhatinda Cantt
MRC	Marichethal
MRCJ	M/S. Ramco Cements Ltd SDG Served By Jaggayapet Town Rly Stn
MRCN	M/S. Ramco Cements Ltd,sdg Served By Narasingapalli
MRD	Manund
MRDA	Maroda
MRDD	Mordar
MRDG	Maradanga
MRDL	Meramandoli
MRDP	Muradpur (Halt)
MRDW	Murdeshwar
MRE	Manauri
MREN	New Manauri
MRF	Marpalli
MRFC	Firozpur Military Ramp Siding
MRFO	MRFO Station
MRFS	Madras Refineries Siding (b. G.)
MRG	Margherita
MRGA	Miryalaguda
MRGB	Military Ramp Siding, Giddarbaha
MRGF	Maurigram Flyover Block Hut
MRGM	Maurigram
MRGR	Gurdaspur Military Siding
MRH	Marmagao Harbour
MRHA	Murahara
MRHT	Moranhat
MRIJ	Murliganj
MRIK	Reliance Industries Ltd Siding
MRJ	Miraj Jn
MRJD	Marajdwa
MRJN	Mirjan
MRJX	Miraj Jn Yard
MRK	Markapur Road
MRKI	M/S. Rita Steel Industries Pvt. Ltd./Knhn
MRKL	Marikal
MRKS	Kapurthala Military Siding
MRL	Maroli
MRLA	Mariyal Gangavadi Ha
MRLB	Ambuja Cements Ltd
MRLI	Murli Halt
MRLM	Marudalam
MRLP	Continental India Ltd
MRM	Mamanduru
MRN	Morwani
MRND	Morinda
MROA	Mora
MROS	M/S Rani & Others
MRPK	Military Ramp Siding. Pakki
MRPL	Marampalli
MRPM	Mathurapur Mor Halt
MRPP	Militray Ramp Siding, Patiala
MRPR	Mau Ranipur
MRPS	Sarna Military Ramp Siding
MRQ	Matari
MRR	Murarai
MRRW	Military Siding, Railwala
MRSA	Amristar Military Siding
MRSB	Batala Military Siding
MRSC	Military Ramp Siding, Chandimandir
MRSD	Dinanagar Military Siding
MRSH	Morshi
MRSM	Military Ramp Siding, Malout
MRSN	Military Ramp Siding, Nabha
MRSR	Ramdas Military Siding
MRST	Taran Taran Military Siding
MRSW	Sahnewal Military Ramp Siding
MRT	Mathura Cantt
MRTA	Muraitha
MRTD	Mortad
MRTL	Mirthal
MRTU	Tanda Urmar Military Siding
MRTY	Murti
MRU	Matunga Road
MRV	Marsul
MRWN	Rajastan Spinning & Weaving Mills Siding
MRWS	Marwar Ranawas
MRX	Murud
MRYA	Meriyana
MRZA	Mirza
MS	Chennai Egmore
MSAE	Masagram
MSB	Chennai Beach
MSBB	Bari Brahman Military Siding
MSBH	Mewa Nawada Block Hut
MSBR	Musahibpur
MSC	Chennai Chetpat
MSCA	M/S. Singareni Collieries Co. Limited
MSCM	M/S. Sagar Cement Limited Siding Served By Mattampalle
MSCS	Modern Satgram Colliery (Jemahary) Sdg.
MSD	Masjid
MSDD	Military Supply Depot Delhi Cantt
MSDG	Mhasoba Dongargaon
MSDH	Masnadih
MSDL	Mahisadal
MSDN	Masudan
MSDR	Murshadpur
MSE	Masani
MSF	Chennai Fort
MSGA	Milatry SDG For Propallent Ordanance Factory Et
MSGD	Military Siding, Dhandera
MSGJ	Maheshganj H
MSGR	Marshaghai Road
MSGS	Madhosingh Goods Shed
MSH	Mahesana Jn
MSHL	Mosale Hosahalli
MSHM	Mahesana
MSHW	Musharwa Halt
MSIB	GCT Multi-Modal Cargo Terminal of Maruti Suzuki India From Bechraji
MSIM	Jayaswal Neco Industries Ltd.
MSIR	M/S Sks Ispat & Power Ltd Rsd
MSK	Mahes Khunt
MSKT	Martyr Cptn Sunil Kr Choudhary Kathua
MSL	Machchalandapur
MSMD	Mahasamund
MSMI	Misamari
MSMM	M/S Sarda Energy & Minerals Ltd SDG
MSN	Mursan
MSNN	Military Siding Nasirabad
MSO	Misrod
MSOD	Masodha
MSP	Mansurpur
MSPC	Mauda Super Tps,ntpc Ltd
MSPJ	M/S Msp Steel and Power Ltd Siding
MSPM	Star Paper Mills Siding Ii, Sre
MSPN	New Mansurpur
MSPS	Maharashtra State Electricity Board Siding
MSPV	M/S Smiore Plant Siding Served By Vyasa Colony Railway Station
MSQ	Marwar Ratanpur
MSQS	Maharajpur Stone Qurry SDG Maharajpur
MSR	Masur
MSRJ	Military Siding Rangiya (BG) Rny
MSRP	Murhesi Rampur
MSRR	M/S. SAIL Rourkela Steel Plant
MSRS	Mineral Sdg. Rjl
MSRT	Tangra Military Siding
MSS	Masarahalli
MSSD	Maheshari Sndhn
MSSL	M/S Super Smelters Limited
MSSN	Maishashan
MST	Masit
MSTB	M/S Sanjvik Terminal Pvt Ltd
MSTH	Misrikh Tirath
MSTR	M/S. Sridhi Transport Co. Pvt. Ltd.
MSTW	Talwandi Military Siding
MSU	Mosur
MSV	Mustra
MSVN	Meswan
MSW	Maskanwa
MSWA	Masaniwala
MSZ	Mansa
MT	Matera
MTA	Mathela
MTAP	Matania Anantpur
MTB	Matlabpur
MTBG	Mathia Barghat Halt
MTBH	Mahatbania Halt
MTC	Meerut City
MTCN	Tiruvallikeni
MTD	Merta Road Jn
MTDB	Merta Road Bypass
MTDC	Chemplast Sanmar Ltd Sdg, Metturdam
MTDE	Military Ramp Siding, Ambala Cantt
MTDI	Maltekdi
MTDM	Mettur Dam
MTE	Mettur
MTFA	Mertala Phaleya Halt
MTGE	Muthani
MTH	Mataundh
MTHH	Mothala Halt
MTHP	Mithapur
MTI	Mitawali
MTIP	Mathnashipur
MTJ	Mathura Jn
MTJL	Motijheel
MTJR	Moterjhar
MTKD	Moti Khawdi
MTKR	Matokhar
MTL	Mailam
MTLA	Mothala
MTLP	Mithila Deep
MTM	Machilipatnam
MTMI	Motimari
MTMP	Mattampalle
MTMY	Thirumayilai
MTN	Matunga
MTNC	Mattancheri
MTND	Mattagajpur
MTNL	Muttarasanallur
MTO	Maitha
MTP	Metupalaiyam
MTPC	Motipura Chauki
MTPH	Upseb Siding Panki
MTPI	Metapalli
MTPK	Maharashtra State Electricity Board Thermal
MTPR	Raimahtpur
MTPS	Mejia Thermal Power Station Siding
MTR	Motipur
MTRA	Matigara
MTRN	M/S. Tisco's Ropeway Siding
MTSB	M/S Jrc Transcon Pvt Ltd GCT At Barajamda
MTSI	Motisadhli
MTSK	Mota Surka
MTSS	M/S Talwandi Sabo Power Ltd.
MTT	Mutupet
MTU	Matmari
MTUR	Mathur
MTV	Matalkunta
MTWN	Mitewani P. H.
MTY	Multai
MU	Makansar
MUA	Musra
MUAT	Private Siding of M/S Utkal Alumina International Limited
MUBR	Manu Bazar
MUC	Mullurcarai
MUCL	M/S Ultratech Cement Ltd.(dankuni Cement Works)
MUD	Muradnagar
MUDI	Mududi
MUDL	Madhujore A Colliery Sdg.
MUE	Mudkhed
MUG	Magra
MUGA	Mahugara
MUGI	Marugutti
MUGN	Mahutgaon
MUGR	Manuguru
MUH	Murthiha
MUHI	Murhari Halt
MUJA	Mengujuma
MUK	Munumaka
MUKE	Mukkali
MULK	Mulki
MUM	Mangapatnam
MUNU	M/S Meja Urja Nigam (P) Limited
MUO	Masangaon
MUP	Murhipar
MUPA	Mupa
MUQ	Marudur
MUR	Mankapur Jn
MURD	Mandawar M Road
MURI	Muri Jn
MUSG	Ordinance Depot Siding , Mathura
MUT	Meerut Cantt
MUTG	M/S. Ultra Tech Cement Ltd. Siding Served By Ginigera
MUTN	New Meerut Cantt
MUU	Mankundu
MUUA	Mahuawa Khurd
MUV	Manduadih
MUVL	Muval Tank
MUW	Mathurapur
MUY	Mugaiyur
MUZ	Mohiuddinpur
MUZN	New Mohiuddinpur
MV	Mayiladuturai Jn
MVA	Malaka Vemala
MVAA	Private Siding of M/S Vedanta Limited
MVC	Mavinkere
MVCS	Muva Concrete Sleeper SDG
MVCT	M/S. Vicat Sagar Cement Pvt Ltd SDG Served By Tandur Rly Stn
MVD	Mulvad
MVE	Mundhewadi
MVF	Manabar
MVG	Maligura
MVH	Mantatti
MVHL	Mavinahalli H
MVI	Morbi
MVIS	M/S Vimla Infrastructure Pvt Ltd
MVJ	Mavli Jn
MVKF	Food Corporation of India Siding
MVKR	Mahavankhor Halt
MVL	Malavli
MVLI	Mevli
MVLK	Mavelikara
MVN	Milavittan
MVNP	Spic Siding, Marshalling Yard of Port of New Tuticorin
MVO	Manwath Road
MVP	Mokhasa Kalvpdi
MVPM	Mavelipalaiyam
MVRD	Maivadi Road
MVRM	Mallavaram
MVS	Manavasi
MVST	Vedanta Limited Private Siding
MVTS	Port of New Tuticorin Siding
MVTY	Marshalling Yard of V. O. Chidambaranar Port Authority
MVV	Maheshi
MVW	Mallividu
MVY	Malavi
MW	Mairwa
MWA	Mandwa
MWAD	Mowad
MWAI	Mawai
MWC	Mandawali Chander Vihar Halt
MWD	Mhasavad
MWE	Mewa Nawada
MWF	Magardaha
MWG	Mindala
MWH	Malwan
MWHN	New Malwan
MWJ	Marwasgram
MWK	Mordad Tanda
MWL	Muthirevula Halt
MWM	Malleswaram
MWMS	Matrix Warehousing Corporation
MWP	Mahrani Pachhim
MWQ	Motari Halt
MWR	Mahansar
MWRN	Madwarani
MWSD	Munidih Washery
MWT	Marwar Lohawat
MWUE	Mahrawal
MWW	Mahwa
MWX	Mallanwala Khas
MWY	Mailaram
MWZ	Mahishadahari
MX	Mahalakshmi
MXA	Marauda
MXD	Masor Road
MXH	Makhu
MXJ	Mangurjan
MXK	Mandrak
MXL	Mokholi
MXM	Minatchipuram
MXN	Mariani Jn
MXO	Morthala
MXP	Malupota
MXR	Mahur
MXS	Mohasa
MXT	Malakpet
MXW	Mahadevsal
MXX	Meerut City Mandi Siding
MXY	Mahuariya
MXZ	Mohadara P. H.
MY	Malliyam
MYA	Mandya
MYD	Manderdisa
MYE	Mandhali
MYG	Miyagam Karjan
MYGD	Maynaguri Road
MYGL	Miyagam Karjan Jn
MYHT	Mayurhat
MYJ	Maheji
MYK	Mayakonda
MYKR	Matyakheri Halt
MYL	Malliyala
MYM	Memari
MYO	Moridhal
MYP	Mundiyampakkam
MYPR	Maynapur
MYR	Maihar
MYS	Mysore Jn
MYU	Mayanoor
MYX	Metyalsahar Halt
MYY	Mayyanad
MZA	Mezenga S
MZB	Mahuli P. H.
MZC	Mirza Cheuki
MZCJ	M/S Zuari Cements Ltd (unit Ii)
MZCY	Zuari Cements Limited Siding
MZGI	Manzurgarhi
MZH	Mauhari
MZHL	Majhaoli
MZJM	M/S. Zuari Cements Ltd.
MZL	Mirzapalli
MZM	Muzzampur Nryn
MZMA	Mazhom
MZN	Mahmudpur Saraiyan Halt
MZNC	Mazgaon Cabin
MZP	Mirzapur
MZPN	New Mirzapur
MZQ	Majgaon Assam
MZR	Murtajapur Jn
MZRT	Murtajapur Town
MZS	Murkeong Selek
MZU	Marandahalli
MZV	Maralahalli
MZW	Manjhwe
MZX	Matatila
MZY	Machapur
MZZ	Manjuri Road
NAB	Nagbhir Jn
NAC	Nawa City
NACC	New Alipur (calcutta
NAD	Nagda Jn
NADA	Nada
NADI	Nawadgi
NADR	Naval Armament Depot
NAG	Nagargali
NAGD	Nagod
NAH	Nahiyer
NAHT	New Ashti
NAI	Nangi
NAK	Naksalbari
NAKD	Naik Dih
NAL	Nal Halt
NALR	Nalpur
NALW	M/S NALCO Siding Vpt
NAM	Namrup
NAN	Nandgaon Road
NANA	Nana
NAND	Nandikoor
NANH	Navanagara
NANR	Naranpur
NAR	Nar
NARA	Nara Halt
NARD	Naika Road Halt
NAS	Nasrala
NASP	Narasingapalli
NAT	Nathnagar
NATD	Narayanpur Anant Txr Depot
NAU	Nadapuram Road
NAVI	New Amravati
NAW	Nawandgi
NAWN	Nawan
NAZJ	Nazirganj
NB	Nimbhora
NBA	Nabha
NBAE	Nabagram
NBCC	Bhartiya Rail Bijlee Company Ltd.
NBD	Najibabad Jn
NBE	New Barrackpore
NBG	Nabinagar Road
NBGC	M/S Ncml Batala Pvt. Ltd.
NBGH	Nowbagh
NBH	Nimbahera
NBHB	M/S. J. K. Cement Works Ltd. Siding
NBHM	Nana Bhamodra
NBHS	J. K.cement Siding Nimbahera
NBI	Nadbai
NBJU	New Barauni Jn
NBK	Nungambakkam
NBKH	Naba Gram Kankurhati
NBL	Nimbal
NBM	Navabpalem
NBP	Nibhapur
NBPH	New Balrampur Halt
NBPM	New Bhaupur
NBQ	New Bongaigaon
NBQS	Nbq Workshop
NBQY	New Bongaigaon Yard
NBR	Namburu
NBRL	Nani Baral
NBRN	Naba Raynagar Halt
NBS	New Baneswar
NBSD	No.6 Bridge SDG .(departmental) Liluah
NBSK	New BALCO Siding, Krba
NBSN	Nowrozabad Ballast Siding
NBT	Nayabagirthipur
NBU	Narasambudhi
NBUE	Nibkarori
NBX	Nizbarganj
NCA	Nizchatia
NCB	New Cooch Behar
NCBD	New Changrabandha
NCE	Nlachrvuru East
NCGS	New Cossipur Generating Station
NCH	Nakachari
NCHS	Nature Cure Hospital
NCJ	Nagercoil Jn
NCLW	Gati Shakti Multi-Modal Cargo Terminal of M/S. Navkar Corporation Ltd.
NCMB	National Collateral Management Services Bhattu Pvt Ltd GCT S By Bhattu
NCMT	M/S National Collateral Management Services Ltd.(ncml) GCT At Tinich
NCN	Nachinda PH
NCP	Nischindapur
NCPM	Nishchindapur Market Halt
NCR	Nagore
NCRM	Nacharam
NCSK	Chowgule-Costi Ltd
NCSN	Nowrazabad Colliery Siding
NCTP	Nischintapur
NCU	Nallacheruvu
ND	Nadiad Jn
NDAE	Nabadwip Dham
NDAM	Nadigam
NDB	Nandurbar
NDBT	Nandpr Bhatauli
NDD	Nidadavolu Jn
NDE	Nandre
NDF	Nabadwip Ghat F
NDG	Nadgam
NDGJ	Nandaigajan P. H.
NDH	Nindhar Benar
NDIM	Nandaigram Halt
NDJ	Nandganj
NDK	Nankhas
NDKD	Nadikode
NDKH	Nandarkha
NDKK	New Daud Khan
NDKR	Nandakumar PH
NDL	Nandyal
NDLH	Nandlalee Halt
NDLS	New Delhi
NDM	Nidamanuru
NDMH	Neredmet
NDN	Nardana
NDNI	Nidhani
NDNR	New Dhanora
NDO	Nidubrolu
NDON	Nadaon Halt
NDPL	Nandipalli
NDPM	Narmadapuram
NDPR	Nandapur
NDPU	Nudurupadu
NDR	Nandesari
NDRT	Nangal Degrota
NDSB	Nilgiri Departmental Siding
NDT	Nathdwara
NDU	Nadaul
NDV	Nidvanda
NDW	Nadwan
NDY	Nandi Halt
NDZ	Nidigallu
NEA	Neykkarapatti
NEC	Nemilicherry Halt
NECV	North Eastern Railway Crew Lobby Varanasi Jn
NED	Nanded
NEDA	New Electric Loco Shed - Government Maintenance Depot, Ajni
NEHL	Netranahalli H
NEI	Neoli
NELK	M/S Nayara Energy Ltd Siding At Kairla
NELM	M/S Nayara Energy Limited, Modpur
NEM	Thiruvananthapuram South
NEMA	Nema Halt
NEO	Neora
NEP	Nenpur
NERH	NER Halt
NERI	Neri
NES	Natesar
NESA	Nava Sheva
NET	Netrang
NEU	Nerul
NEUA	Nemua Halt
NEW	Nivari
NEWC	New West Cabin
NEYT	Ntpc's Exchange Yard Talcher
NFAG	Pvt. Sdg. of M/S. NTPC Fly Ash Siding/Gad
NFC	Nuclear Fuel Complex
NFK	New Farakka Jn
NFKB	New Farakka B Cabin
NFKN	New Farakka N Cabin
NFKS	New Farakka S Cabin
NFLB	NFL Siding
NFLD	N. F.l. Siding, Diwana
NFLG	National Fertilisers Limited Siding
NFLN	NFL Siding
NFPG	Nfst Served By Shirva
NG	Nagari
NGA	Ningala
NGAN	Nagaon
NGB	Nawabganj Gonda
NGC	New Guwahati G/Shed
NGCK	North Govindpur Public SDG
NGCM	Military SDG Narengi (Ngc)
NGCT	New Guwahati (Ngc) Txr Point
NGD	Nagardevla
NGDM	Nagra Dham P. H.
NGE	Nagar
NGEC	General Elecrtic Co Siding ,naini
NGF	Nagarnabi
NGFS	Nagarjuna Fertilizers and Chemicals Ltd
NGG	Nagina
NGHW	Nageshwadi Halt
NGI	Nagri
NGIM	Nagri Gram
NGJA	Narayanappavalasa Halt
NGJN	Nagarjuna Nagar Halt
NGL	Nagal
NGLT	Naglatula
NGM	Nagasamudram
NGMN	New Gumandev
NGMP	New Garh Madhopur
NGMS	M/S Cesc Ltd (new Generating Station) Mulajore Kankinara
NGMW	Nagamalai West Halt
NGN	Nandgaon
NGNC	New Guntur Cabin
NGNH	Nandagaon Halli Halt
NGNT	New Guntur
NGNX	Nandgaon Yard Cabin (Txr)
NGO	Nagaur
NGON	Naugaon
NGP	Nagpur Jn
NGPD	Nagpur D Cabin
NGPM	Nidiguntapalem
NGR	Annigeri
NGRD	Nilgiri Road
NGRH	New Giridih
NGRI	New Garia
NGRM	M/S Ramsarup Industries Limited
NGRS	Nagrota Suriyam
NGRT	Nagrota
NGS	Nagansur
NGSM	New Mulund Goods Depot
NGT	Nagappattinam Jn
NGTG	New Gitldada Jn
NGTN	Nagothane
NGV	Naglavi
NGW	Nauganwan
NGWN	Noganwan
NGX	Nigan
NGY	Nath Ganj
NGZ	Shri-Kshetra Nagjhari
NH	Naihati Jn
NHB	Noh Bachhamdi
NHF	Nihasta Halt
NHFG	New Power House Siding,faridabad
NHGJ	New Harangajao
NHH	Nihalgarh
NHK	Naharkatiya
NHLC	Naihati Link Cabin
NHLG	New Haflong
NHLN	Naharlagun
NHM	Nandol Dehegam
NHN	Nigohan
NHR	Nohar
NHRS	New Hathras
NHS	Naihati South Cabin
NHSB	New In-Plant Siding of M/S Hindustan Steel Ltd
NHSR	Rangapani Public (Railway) Siding
NHT	Nalhati Jn
NHU	Nahur
NHX	Narthar
NHY	Naganahalli
NHYD	Naihati Yard
NI	Naydongri
NIA	Janjgir Naila
NID	Nidur
NIDB	M/S Nmdc Store Sdg, Barbil
NIDI	Nidi
NIG	Naigaon
NIIJ	Nilaje
NIL	Nilambur Road
NILE	Nimitita
NIM	Nimdih
NIMA	Nimkakhera
NIMG	Nima Gopalpur Halt
NIN	Nimkana
NINS	Neelachal Ispat Nigam Ltd
NIP	Nizampur
NIQ	Nigaura
NIR	Nainpur Jn
NIRA	Nira
NIT	Naikot
NITR	NSCB Itwari Jn
NIU	Nabipur
NIV	Nivasar
NJA	Nagjua Fs
NJAJ	New Jhajha Jn
NJB	Nijbari
NJM	Naruana Jodhpur Ramana
NJML	M/S Muddea Jute Mills , Kankinara
NJN	Naojan
NJP	New Jalpaiguri
NJPT	New Jalpaiguri (Njp) Txr Point
NJT	Nager Coil Town
NK	Nasik Road
NKB	Nagrakata
NKBR	Narkatia Bazar Halt
NKCA	New Kusmunda Cabin
NKCN	New Karchana
NKCR	New Kusmunda Colliery
NKD	Nekonda
NKDO	Nakkanadoddi
NKE	Narkatiaganj Jn
NKG	Narkeldanga Coaching Yard
NKH	Nathukheri
NKI	Naikheri
NKJ	New Katni Jn
NKK	Narikkudi
NKKB	New Kusmunda Colliery Siding Line No. 1/Krba
NKKH	Nimpura Goods Shed Complex
NKL	Nalikul
NKLE	New Kaithal Halt
NKM	Namkom
NKMG	New Karimganj
NKMS	Namkom Military Siding
NKN	Nyoli Kalan
NKOT	New Kota (dakaniya Talav)
NKP	Nirakarpur
NKPL	Narketpalli
NKPU	Nekpur
NKR	Nimar Kheri
NKRA	Nokhra
NKRKL	Nekarikallu
NKSG	Security Presssiding Nasik
NKU	Nakardei
NKW	Nilakantheswar Asthan
NKX	Nakati Semra
NLA	Nancherla
NLBR	Nilambazar
NLC	Naliya Cantt
NLCP	New Lakidih Open Cast Project Siding
NLD	Nalanda
NLDA	Nalgonda
NLDM	Nangal Dam
NLE	Nileshwar
NLGS	M/S Nagpur Mmlp Gati Shakti Multi-Modal Cargo Terminal
NLH	Naultha
NLI	Namli
NLK	Navlakhi
NLKR	Nilokheri
NLKT	Nalkata
NLL	Nalli
NLN	Nailalung
NLNI	New Loni
NLNR	Nulemuru
NLOD	NALCO Siding Damanjodi
NLP	North Lakhimpur
NLPD	Nallapadu
NLPI	Nemalipuri
NLQ	Nangal Pathani Halt
NLR	Nellore
NLRD	Necklace Road
NLRT	New Lalitpur Town
NLS	Nellore South
NLSF	Niyalish Para
NLSK	Private Siding of M/S. NTPC Lara Stpp / Krl
NLV	Nalbari
NLY	Naliya
NM	Naimisharanya
NMA	Nirmali
NMAG	Private Siding of M/S Nmdc Steel Ltd, Amagura
NMBR	N Mayurbhanj Road
NMC	Nimcha
NMCL	Nimcha Colliery Siding
NMD	Nomoda
NMDA	New Morinda
NMDB	Nmdc's Iron Ore Loading Deposit No. 5 Bacheli
NMDG	National Mineral Development Corporation Siding, Gua
NMDJ	Nm Dubash Siding Jukehi
NMDM	Nm Dubash SDG Megn
NMDR	Nimdanri
NMF	Nimo
NMFS	Bharamputra Valley Fertiilizer Corpn (P)(bg)
NMG	Nimiaghat
NMGA	Nelemangala
NMGS	Numaligarh Refinery Project Siding (P) (BG)
NMGT	Nmg Tamdalge
NMGY	Numoligarh
NMH	Nimach
NMHI	New Manjhi
NMJ	Nidamangalam Jn
NMK	Nim ka Thana
NMKA	Namkhana
NMKL	Namakkal
NML	Nellimaria
NMLU	Nemakallu
NMM	New Misamari
NMMS	Nimpura Military Siding, Nimpura
NMN	Namanasamudram
NMO	Nedi Mollyanur
NMP	Nimpura
NMPY	Nimpura Marshalling Yard
NMS	Nagrota Military Siding
NMSG	Nepa Limited Siding
NMT	Namtiali
NMUE	Numaishgarh Halt
NMVK	Nmdc's Mallinger Valley Siding Kirandul
NMVP	Mahagenco New Parli Thermal Power Station Siding
NMWP	New Majhagawan Phatak
NMX	New Maynaguri
NMY	Noonmati
NMZ	New Mal Jn
NN	Nandura
NNA	Naugachia
NNB	Nimblak
NNCN	Nagnath Cabin
NNE	Nonera
NNGE	Narangi
NNGL	Nayanangal
NNHT	Nonihat
NNKR	Nanaksar
NNL	Narnaul
NNM	Nannilam
NNN	Nanguneri
NNNL	Nandani Lagunia
NNO	Nangloi
NNP	Nanpara Jn
NNPR	Nonapar
NNR	Narayanpur
NNU	Nangal Mundi
NNV	Nanwara
NNW	Narayanpur Tatwara
NNWH	New Nawadih
NNX	Nanauta
NOA	Nosaria
NOB	Nobanda
NOD	Na Nadi
NOH	Nigohi
NOI	Nariaoli
NOK	Nokha
NOL	Niyol
NOLB	Nolbari
NOLI	Noli
NOMD	Noamundi
NON	Nonar Halt
NOQ	New Alipurduar
NOR	Neora Naddi
NOSM	Nossam
NOY	Noyal
NPB	Nagapattinam Beach
NPBR	Narayanpur Bazar
NPBW	New Public Siding Barharwa .
NPD	Nawapara Road
NPDC	Nishatpura D Cabin
NPDY	Nimpura Departure Yard
NPGA	Nabinagar Super Thermal Power Station
NPH	Nurpura
NPHR	New Pandharpavani
NPI	Nipania
NPJE	Nichitpur
NPK	N. Panakudi
NPKM	Nandiyampakkam
NPKRP	Nandanpur Kerarpara Halt
NPL	Nagalapalle
NPM	Nellikuppam
NPML	Mallial (Nukapalli)
NPMR	Narayan Pakuria Mura
NPNR	Nepanagar
NPR	Nepalganj Road
NPRD	Nagpur Road PH
NPRY	Nimpura Receiption Yard
NPS	Napasar
NPSB	M/S Nabha Power Ltd. Siding
NPT	Narasingampet
NPTY	Nimpura Through Yard
NPU	Nadiapur
NPV	Narpatganj
NPW	Nipani Vadgaon
NPX	Narindarpura
NPZ	Nawapatra
NQH	New Domohani
NQR	Naraj Marathapur
NQSG	New Vehicle Factory Siding
NR	Niphad
NRA	Nunkhar
NRCC	North Ramgarh Siding
NRD	Naroda
NRDP	Nagireddipalli
NRE	Nandalur
NRF	Neralakatte Halt
NRG	Nergundi
NRGO	Narganjo Halt
NRGR	Naranjipur
NRH	Nahargarh
NRI	Naraina
NRJ	Narimogaru
NRK	Naraikkinar
NRKE	Nari Khetri
NRKG	Narkatiaganj Jn.(mg)
NRKP	Narkopi
NRKR	Narkher
NRL	Neral
NRLM	Nirolgram
NRLN	Neral Narrow Gauge passenger platform
NRLR	Norla Road
NRM	Nurmahal
NRMH	Nava Raipur
NRN	Singhiaghat
NRNR	Nurnagar
NRO	Nakodar Jn
NROB	New Rajanagar Open Cast Mines
NROD	Nari Road
NRP	Narsipatnam Road
NRPA	Naraynpur Anant
NRPD	Narayanpet Road
NRPM	Nrp Murli Halt
NRPR	Narendrapur Halt
NRR	Nagarur
NRS	Nagaria Sadat
NRSD	New Runnisaidpur Halt
NRSG	National Rayon Corpn. SDG
NRSI	Noorsarai Halt
NRSP	Narasmhapura
NRSR	Numaligarh Refinery Oil (Pvt/BG) Siding
NRT	Narasaraopet
NRUR	Nareshwar Road
NRV	Nariyar
NRVR	Naraina Vihar
NRW	Narwana Jn
NRWI	Narwasi
NRWN	Nangal Rajawatan
NRX	Noadar Dhal
NRY	Nyoriya Husenpur
NRYP	Narayanapuram
NRZB	Nowrozabad
NS	Narasapur
NSA	Nishangara
NSBG	New Sisiborgaon
NSCL	New Silchar
NSD	Nasirabad
NSF	Nasibpur
NSGR	Narasinghgarh
NSI	Nikursini
NSIR	New Sirhind
NSK	Nagsankar
NSKG	Naval Siding Karanja, Uran City
NSKL	Naskhal
NSL	Nagarsol
NSMH	New India Sugar Mills Ltd SDG
NSN	Nasirpur Halt
NSO	Nashipur Road
NSP	Nalla Sopara
NSPH	Narasapurapupeta
NSPN	M/S. NTPC Ltd. Super Thermal Power Siding-Khargone Served By Nimarkheri
NSRH	Niz-Sariha-Halt
NSS	Nawashahr Doaba Jn
NSTG	New Satgram Colliery Sdg.
NSU	Nisui
NSVP	National Police Academy Shivarampalli
NSW	Naswadi
NSWT	Nalhati No1 Sdg., Nalhati Jn
NSX	Narsipuram Halt
NSZ	Nishatpura
NT	Nathpura
NTA	Netra
NTCD	NTPC Siding, Dadri
NTDG	NTPC Dipka Silo
NTDM	Nityanand Dham
NTG	Nursratabad Kharkhar
NTKS	NTPC Pvt Sdg. Clg
NTM	Narthamalai
NTMK	NTPC Talaipalli Mines
NTN	Nar Town
NTPB	Private Siding of M/S NTPC Gadarwara Railway Siding Served By Baranjh
NTPC	National Thermal Power Corpn
NTPG	New Thermal Power Station Siding-Chandrapur
NTPR	Track Hopper At M/S. NTPC SDG/Served By Rdm
NTR	Nittur
NTS	Nattrasankottai
NTSJ	M/S. Navkar Corporation Ltd. At Tumb
NTSK	New Tinsukia
NTST	New Tinsukia (Ntsk) Txr Point
NTT	Nathapettai
NTU	Nigatpur
NTV	Nautanwa
NTVT	Nethravathi
NTW	Nanjangud Town
NTWL	Netawal
NTZ	Nathwana
NU	Narsinghpur
NUA	Nua
NUB	Nurabad
NUD	Navagadh
NUGN	Nuagan
NUGP	North Urimari GCT of CCL
NUH	Naugarh
NUIH	Neuri Halt
NUJ	Nujella
NUPR	Nurpur Road
NUQ	Nagar Untari
NUR	Narela
NVA	Nindra
NVC	Nagalwancha
NVCN	Existing R&d Yard of M/S Nuvoco Vistas Corporation Ltd Served By Npi
NVD	Navalgund Road
NVF	Nagavangala
NVG	Nawagaon
NVI	Navinal
NVK	Neyvilakku
NVL	Neyveli
NVLN	Nawalgohan
NVP	Navalpura
NVRD	Navade Road
NVS	Navsari
NVT	Navipet
NVU	Navalur
NW	Nalwar
NWA	Nagarwara
NWB	Niwas Road
NWBV	Nwbv Cabin
NWC	Naya Nagar
NWD	Nawadah
NWDH	Nawadih
NWH	Nawalgarh
NWMS	Noapara Mahishasur H
NWN	Nanwan
NWOC	Ambala Cantt New West Outer Cabin
NWP	Naupada Jn
NWR	Niwar
NWRN	Nalwar North
NWSI	Nawal Sahi Halt
NWSN	Nigahi Wharfwall NCL Siding
NWU	Navapur
NXH	Nidaghatta
NXL	Nirol Halt
NXN	Nuagaon
NXNR	Nuagaon Road
NXR	Nagsar
NYA	Narayangarh
NYDO	Narayandoho
NYG	Nayagarh
NYGT	Nayagarh Town
NYH	Nayandahalli
NYI	Nellayi
NYK	Naya Kharadia
NYM	Neyamatpur
NYMT	NTPC Exchange Yard, Talcher
NYN	Naini
NYO	Nayagaon
NYP	Nayudupeta
NYRH	Nayarhat
NYT	Nayatola
NYY	Neyyattinkara
NZB	Nizamabad Jn
NZD	Nuzvid
NZG	Nazarbag
NZH	Nidaghatta Halt
NZM	Hazrat Nizamuddin Jn
NZP	Niyazipur Halt
NZR	Nazira
NZT	Nazareth
OBAC	Obra-A-Cabin
OBM	Obalapuram
OBR	Obra Dam
OBVP	Obulavaripalli
OCH	Odhaniya Chacha
OCIG	Pvt. SDG of M/S Dalmia Cement (Bharat) Ltd.
OCIM	M/S. Orient Cement Limited Served By Mmz Stn
OCMS	Ocm Siding, Asr
OCPC	M/S. Orient Cement Limited
OCR	Ochira
OCSB	Orient Cement SDG Bhadli
OCSR	Orient Colliery SDG
OD	Od
ODB	Oodlabari
ODC	Oddanchatram
ODG	Obaidulla Ganj
ODHA	Odha
ODM	Ondagrarm
ODUR	Odur
OEA	Odela
OEC	Ore Exchange Yard, Waltair Marshalling Yard
OEL	Oel
OFB	Ordnance Factory
OFLD	M/S. Oriental Foundry Privite Limited
OGL	Ongole
OGM	Oorgaum
OHAN	Ohan
OHV	Odhava
OKA	Okhla
OKAC	Okhla Bypass B Cabin
OKD	Okha Madhi
OKHA	Okha
OKL	Ottakkal
OKSG	Indian Iron and Steel Ltd - Oka
OKSR	Old Kusumunda Colliery Siding
OLA	Olakur
OLP	Olapur
OLR	Ollur
OM	Omkareshwar Road
OMB	Umbermali
OMDC	Omdc SDG No. 2 At Barbil
OML	Omalur
OMLF	Old Malda
ON	Unnao Jn
OND	Aunlajori Jn
ONGC	M/S. Oil and Natural Gas Commission Siding
ONGG	M/S Oil and Natural Gas Commission Siding -Gothangam
ONR	Coonoor
OPIM	M/S. Orient Paper & Industries Limited Served By Mmz Stn
OPL	Uppal
OPM	Onnupuram
OPN	Ponnupuram H
OPSG	Orient Paper Mills Siding Amlai
ORAI	Orai
ORC	Orchha
ORDI	Ordi
OREH	Ore Halt
ORGA	Orga
ORH	Oddarahalli
ORHD	Bharoli Military Siding
ORKI	Orki
ORR	Orr
ORW	Orwara
OSA	Ausa Road
OSBK	Old Sick Line, Barkakana
OSN	Osiyan
OSRA	Osra
OTD	Ootwar
OTK	Ottakovil
OTN	Oating
OTP	Ottappalam
OTPS	Obera Thermal Project Stn Siding
OTR	Moturu
OV	Ottivakkam
OYR	Waria
PAA	Patas
PAAL	Shri Kshetra Pala
PAAS	M/S Ahir Salt and Allied Products Pvt. Ltd. Served By Shirva
PAB	Pattabiram
PAC	Palliyad Road
PACL	Primo Chemicals Ltd.
PACS	Paramand & Co. Sdg. , Pakaur
PACT	Ambuja Ciment Estt Ltd. SDG
PAD	Pardi
PADH	Pipradih
PADI	Padi
PADL	Padil
PADN	New Pardi
PAE	Palana
PAGM	Pennada Agrhrm
PAGT	Pasighat
PAHB	Pura Halt
PAHD	Gati Shakti Multi-Modal Cargo Terminal of M/S Acb (India) Ltd.
PAI	Pabai
PAIL	Pali Halt
PAJ	Paraj
PAK	Pakala Jn
PAKI	Pawakhali
PAL	Palasner
PALB	M/S Adani Logistics Ltd. Pft
PALI	Pali
PALM	Palaiyam-I
PALR	Palur
PAM	Panapakam
PAN	Panagarh
PANP	Pandavapura
PAO	Panoli
PAP	Pithapuram
PAPK	M/S. Adhunik Alloys & Ower Ltd. Served By Kandra Stn.
PAPM	Palata Potaram
PAQ	Padiya Nagla
PAR	Pandhurna
PARD	Pathrad
PARH	Padarkheda
PAS	Pasur
PASA	Parassala
PASG	Panisagar
PASR	Panduranga Swamy Road
PATA	Pata
PATI	Parsa Tewari
PATL	Patel Halt
PATM	Patam
PATP	Adani Agri Logistics Ltd
PATR	Paramjeevar Tarajeevar
PAU	Purna Jn
PAV	Pedana
PAVI	Pavi
PAVP	Pedda Avutapale
PAW	Pandabeswar
PAX	Patti
PAY	Payyanur
PAYS	Food Corporation of India Sdg,payanur
PAZ	Payangadi
PAZHT	Pazhangottai
PB	Puntamba
PBA	Piardoba
PBAP	Pabbapuram Halt
PBB	Parbatonia
PBBM	Pump Storage Asstt. Cum Pvt SDG of M/S Wbseb
PBC	Parbatsar City
PBCB	BPCL Siding - Bakania Bhaunari
PBCM	M/S Bhilai Jaypee Cement Limited
PBCP	BPCL Siding Panki
PBD	Peddabrahmadevam
PBE	Pilibhit Jn
PBH	Partapgarh Jn
PBHD	Prabhadevi
PBJM	Pbnwa Jasmhndar
PBJT	Pvt. SDG of M/S Dalmia Cement (Bharat) Ltd.
PBKS	Pambakovil Shandy
PBL	Pathsala
PBLP	Phulbasia Line No.1 CCL
PBLS	Pathshala Public Siding ( Rly)
PBM	Pamban Jn
PBMB	Pamban (B)
PBN	Parbhani Jn
PBP	Pembarti
PBPS	Bharat Petroleum Corp Ltd (lpg & Pol) SDG
PBQ	Patherdih Bazar Halt
PBR	Porbandar
PBS	Purab Sarai
PBSB	Pvt Siding on Bxf SAIL Siding
PBV	Paliba
PBW	Pantnagar
PBWB	Bhelatand Washery, Bhelatand
PBZ	Porabazar
PC	Pachora Jn
PCAB	PCAB Station
PCC	Prachi Road Jn
PCCM	Pondri Hill Colliery Siding
PCCS	Patherdi Coal Washery
PCCT	M/S. Chettinad Cement Corporation Private Limited
PCD	Pattakudi
PCDR	Panchdeori Halt
PCEK	M/S Cseb Siding
PCF	Penchipenchi
PCG	Pench
PCGN	Pachegaon
PCH	Pachhapur
PCHA	Pachola
PCIH	Prism Johnson Limited Siding Hnm
PCK	Pachrukhi
PCKM	Pachchakuppam
PCL	Pulicherla
PCLI	Palachauri
PCLM	Panchalam
PCLS	Pirpainti Coal Ldg Rly Siding
PCM	Pavurchatram
PCMB	M/S. Panyam Cements & Minerals Industries Ltd SDG Svd By Bey
PCMC	Chhabara Thermal Power Station Siding
PCMK	Pachar Malikpur
PCML	M/S Panem Coal Mines Ltd. Sdg.pkr
PCN	Panch Piplia
PCO	Palayankottai
PCOI	Prayagraj Chheoki
PCP	Palsap
PCPK	Multi Modal Logistic Park
PCPN	M/S. Nuvoco Vistas Corporation Ltd. Served By Nipania
PCQ	Pichkurirdhal
PCR	Panchra
PCRG	Container Corporation of India Limited
PCSK	Pcm Concrete Sleeper Siding (Pub)
PCSP	Mandarboni & Madahaipur Colly. SDG
PCSR	Phosphat Co. SDG ., Rishra
PCSS	New Kenda Colly. SDG
PCT	Panchtalavda Road
PCTM	Puduchattiram
PCU	Putlacheruvu
PCV	Palakkodu
PCW	Perambur Carriage Works
PCWD	Dp World Multimodal Logistics Private Limited.
PCX	Pagla Chandi
PCY	Pipar City
PCZ	Pocharam
PD	Pharadahan
PDA	Pundooah
PDAI	Private Siding For Dfccil At New Ahraura Road
PDCH	Public Siding At Haldia Demu Coach Factory
PDCR	Domestic Container Terminal (CONCOR)
PDD	Padubidri
PDE	Pindrai
PDF	Padampur
PDFK	Dfccil Construction Depot Siding
PDG	Paradgaon
PDGL	Pondugula
PDGM	Pudunagaram
PDGN	Padhegaon
PDGP	Pdgm Ganeshpura
PDGR	Mumbai (parcel Depot Grant Road)
PDH	Padadhari
PDI	Palasdari
PDJ	Phiding
PDKM	Peddanayakkanpalaiyam
PDKN	Pedakakani Halt
PDKT	Pudukkottai
PDL	Pendekallu Jn
PDLB	Peddapalli Bypass Cabin
PDLL	Adani Logistics Ltd, Patli
PDLM	M/S Distribution Logistics Infrastructure Limited
PDLS	Panari Dalla Private Siding
PDM	Pandikanmoi
PDMA	Padma
PDMI	Pendlimarri
PDNA	Peddadinne
PDNR	Padnur
PDO	Poodoor
PDP	Padse
PDPB	M/S Deepak Steel & Power Ltd. Pvt. SDG
PDPH	Padapahar Jn
PDPK	Padmapukar
PDPL	Peddapalli
PDPR	Purandarpur
PDQ	Padla
PDR	Payagpur
PDRA	Padra
PDRD	Pindra Road
PDS	Pindarsi
PDSN	Peddasana
PDT	Pendurti
PDTK	Dheendamdhu Chottu Ram Thermal Power Project Yamuna Nagar
PDU	Ponduru
PDV	Pandaravadai
PDW	Pandaul
PDWA	Pindwara
PDX	Payradanga
PDY	Pondicherry
PDZ	Piloda
PEA	Pettai
PEC	Pencharthal
PECP	M/S. Nu Vista Limited
PED	Pipardahi
PEE	Paterhi
PEH	Pathardih Jn
PEI	Perani
PEL	Polireddipalem
PEM	Peralam Jn
PEMJ	Pvt Siding of M/S Odisha Mining Corporation Limited (Omcl) At Appahatu
PEN	Pen
PEP	Phephna Jn
PEQ	Binny Ltd. Siding
PEQP	GCT of M/S Paradip East Quay Coal Terminal Pvt Ltd.
PER	Perambur
PERM	Pherima
PERN	Pernem
PERR	Perur
PES	Phesar
PESB	M/S. Electrosteel Casting Ltd
PETA	Pandetola
PEU	Perashshannur
PEW	Perambur Loco Works
PFCB	Food Corporation of India, Bellary Cantonment
PFCI	Food Corporation of India
PFCR	FCI Siding
PFL	Piprala
PFM	Phaphamau Jn
PFMA	Pfm Byepass A Cabin
PFMB	Phaphamau Bypass B Cabin
PFMJ	Pfm Byepass Jn Cabin
PFPD	M/S Palogix Infrastructure Pvt. Ltd/Dgr
PFR	Pachor Road
PFT	Pothahi
PFU	Padua
PG	Pergaon
PGA	Pagara
PGBB	M/S Global Coal & Mining Pvt Ltd
PGC	Panchgachia
PGCG	M/S Gujrat State Electricity Corpn Ltd
PGDI	Pagidirai
PGDP	Pgdp
PGFC	M/S. Coromandal International Limited
PGFS	M/S Gateway Rail Freight Ltd Pft (Bf)
PGFV	M/S Godavari Fertilizers and Chemicals Ltd, Vpt
PGG	Penganga
PGI	Parpanangadi
PGK	Pili Bangan
PGL	Pagdhal
PGMD	Pragati Maidan
PGN	Perugamani
PGP	Panduranga Puram
PGR	Pugalur
PGRL	Piduguralla
PGRN	Piduguralla New
PGRS	Tamilnadu News Print and Papers Ltd SDG
PGSA	Pvt Sdg. of M/S Steel Exchange India Ltd
PGT	Palakkad Jn
PGTN	Palghat Town
PGTS	Food Corporation of India SDG
PGU	Padugupadu
PGW	Phagwara Jn
PGZ	Perunguzhi
PH	Panoh
PHA	Patharia
PHC	Panchot
PHD	Phaphund
PHDL	M/S Palogix Infrastructure P/Lt Pft (Gf)
PHE	Pahaleja Halt
PHEC	M/S Hind Energy & Coal Benefication (India) Ltd.
PHI	Panikhaiti
PHK	Punarakh
PHLG	Pahlejaghat
PHLR	HPCL Siding Ranchi Road
PHM	Patapatnam
PHN	Pokhrayan
PHNJ	M/S Pristine Hindustan Infraprojects Pvt Ltd
PHOP	Phoop
PHQ	Pardhande
PHR	Phillaur Jn
PHRH	Panch Rukhi
PHS	Ferozeshah
PHSH	Upseb Siding , Harduaganj
PHU	Pahur
PHV	Pirthiganj
PHVP	Paschima Vahini Point
PHWR	Pehowa Road
PHX	Pathakpur
PHY	Phariha
PI	Padli
PIA	Pipraigaon
PIBC	Pibco SDG Dgr
PIC	Paricha
PICN	IOC Siding Navalur
PICP	Pft of M/S Paradip International Cargo Terminal Pvt. Ltd.
PICS	IOC Ltd Jayant SDG
PID	Pipardi
PIDH	Pol (ioc, Hpc and Bpc) Siding Dhanbad
PIDN	M/S Pegasus Inland Container Depot Pvt. Ltd. GCT Served By Namli
PIGT	Pilighat
PIH	Parhihara
PIJ	Pij
PIL	Piler
PILD	M/S. Plasser India Pvt. Ltd. Taking Off From Lakodara
PIO	Pilol
PIOP	Pol SDG For M/S IOC
PIP	Piplia
PIRN	Piperan
PIRO	Piro
PIS	Piska Fs
PISK	M/S Ind Synergy Ltd
PIT	Palitana
PIZ	Pingli
PJ	Peppeganj
PJA	Pajian
PJB	Paniajob
PJCR	M/S. J K Cement Ltd./Rpd
PJCS	P. K.seam Asstt. Colly.sdg
PJGM	Panjgam
PJH	Pirjhalar
PJK	Panj Kosi
PJLE	Panjwara Road
PJMS	Presidency Jute Mill SDG ., Ris
PJN	Panjhan
PJP	Panjipara
PJPB	Pvt. Sdg. of M/S. Jhabua Power Limited/Vnk
PJPD	Private Siding of M/S. Jindal Steel Limited
PJPI	Parjapati Halt
PJPR	Priyadarshini Jurala Project Road
PJPT	Prajapati (Halt)
PJR	Pangri
PJSB	Pvt. Siding on Bxf Line No 7, M/S Jindal Steel and Power Ltd
PJY	Para Jani Halt
PK	Pakni
PKA	Pradhankhunta
PKB	Patharkhola
PKBS	Peeplee ka Bas
PKC	Pakra
PKCI	Grasim Industries Ltd.
PKD	Penukonda
PKDE	Pilu Khera
PKE	Pimpar Khed
PKEO	Panskura East
PKF	Pokla
PKGM	Phakhoagram
PKJN	Pakhajan
PKK	Pakki
PKL	Papinayakanahalli
PKM	Periyanayakanpalayam Halt
PKNA	Pakhna
PKNB	Private Siding of M/S Khatau Narbheram & Co Served By Bolanikhadan
PKNS	Pokharni Narasinha
PKO	Palakollu
PKPK	M/S Krishnapatnam Port Company Ltd. Siding, Krishnapatnam
PKPU	Peddakurapadu
PKQ	Pattikkad
PKR	Pakur
PKRA	Parsa Khera
PKRD	Pakaria Road
PKRH	Parsa Kerwan Halt
PKRW	Pakur Lower Quarry Line No.1
PKRX	Pakur Lower Quarry Line N0 2 SDG
PKRY	Pakur New Siding and Raja Buffer
PKRZ	Pakur Old Siding and Pakur Quarry Buffer
PKT	Pattukkottai
PKU	Panskura
PKW	Pilkhua
PKWN	New Pilkhua
PKX	Pakhruli
PKY	Pilkhani
PKYN	New Pilkhani
PKZ	Ppli Pkhi Kalan
PL	Lower Parel
PLA	Palia
PLAE	Palsit
PLAL	GCT Multi-Modal Cargo Terminal of Leap Agri Logistic From Liliya Mota
PLBG	Pol Siding For M/S. Bharat Petroleum Corpn. Ltd.
PLBR	BPCL Siding Rairu
PLBS	Phulbasia
PLCJ	Phalodi Jn
PLCP	Phulbasia Line No.4 CCL
PLD	Paldhi
PLDR	Piludrapiludra
PLE	Piplee
PLF	Piali
PLG	Palghar
PLGD	Pvt Siding of M/S. Landt Clinker Grinding
PLGH	Paligarh
PLH	Paralakhemundi
PLHL	Palahalli Halt
PLHW	Palhawas
PLI	Pettaivayatalai
PLIN	M/S. Lakshmi Narasimha Swamy Infrastructure Pvt., Ltd (Plin)
PLIR	M/S. Srikalahasthi Pipes Limited
PLJ	Palej
PLJE	Phulwartanr
PLK	Plk
PLKN	Palakkanuthu
PLL	Parli
PLLD	Phaltan
PLM	Paneli Moti
PLMC	Chettinad Cement Corp Pvt Ltd Sdg, Palayam
PLMD	Pilamedu
PLMG	Puliyamangalam
PLMX	Palampur Hmchl
PLNI	Palani
PLO	Pulgaon Jn
PLP	Phulpur
PLPC	M/S Pristine Mega Logistics Park Pvt. Ltd. (Pft)
PLPM	Palappuram
PLPU	M/S Korba Power Limited Served By Urga Station
PLQ	Pulakurthi
PLRD	Padaliya Road
PLRM	Moga Military Platform Siding
PLS	Pipalsana
PLSG	Palasingi
PLSN	Palsana
PLT	Pirthala Llauda
PLU	Patakottacheruvu
PLV	Palsi
PLVA	Pallevada
PLVI	Paluvayi Halt
PLVR	Palam Vihar Halt
PLW	Pingleshwar
PLWR	Phulwaria
PLY	Plassey
PM	Palam
PMAB	M/S Ambuja Cement Ltd
PMAK	M/S ACC Limited Siding Served By Kudathini
PMAM	M/S Adani Power Ltd.
PMAR	M/S Adhunik Metaliks Ltd Krmd
PMB	Pullambadi
PMBG	M/S. Phil Minerals Benefication & Energy Pvt. Ltd.
PMBR	M/S. Bmm Siding Served By Ranajithpura
PMCJ	Pvt. SDG of M/S. Mahavir Coal Washeries Pvt. Ltd./Nia
PMCS	Pandra Br Colly. SDG
PMD	Pamidi
PME	Pandu Mewas
PMEB	Private Siding of M/S. East India Mineral Ltd.
PMEC	M/S Gmr Warora Energy Ltd
PMFB	Pvt SDG of M/S Rungta Sons Pvt Ltd (at Bolanikhadan)
PMGN	Pimpalgaon
PMH	Parao Mahna
PMHD	Pol Siding of M/S. HPCL
PMHK	M/S Hothur Ispat Private Siding Kudatini
PMHL	Pvt. Sdg. of M/S. HINDALCO Industries Ltd. , Lohardaga
PMHP	Private Freight Terminal (Pft) of M/S Musaddilal Holdings Private Ltd
PMI	Paimar
PMIB	Pvt. Sdg. of M/S. IOC Limited
PMIP	M/S. Indian Farmers Fertiliser Co-Operative Ltd.
PMK	Paramakkudi
PMKM	Dp World Rail Logistics Private Ltd.
PMKT	Pimpalkhuti
PML	Papanasam
PMLR	M/S Nuvoco Vistas Corporation Limited
PMM	Parsehra Mal
PMN	Paman
PMO	Pandoli
PMP	Pimpri
PMPE	Pampur
PMPN	New Malikpur Crossing Station
PMPR	Prempur
PMQ	Parna Nand
PMR	Pitambarpur
PMRB	Pvt. Sdg. of M/S. Rungta Mines Ltd. [at Barbil]
PMRG	Rajiv Gandhi Thermal Power Plant, Khedar
PMRN	Private Siding of M/S Rashmi Metaliks Ltd At Gokulpur
PMRP	M/S Rosa Power Supply Company Ltd. Siding, Rosa
PMS	Parmalkasa
PMSB	M/S JSW Steel Limited
PMST	Pathankot Military Siding, Pathankot
PMT	Pullampet
PMU	Parmanandpur
PMY	Pali Marwar
PMYA	Parminiya Halt
PN	Pansar
PNB	Panbari
PNBB	New Bhimsen
PNBE	Patna Jn
PNC	Patna Saheb
PNCB	Pancheberia
PNCM	M/S National Collateral Management Services Ltd (greenfield Pft)
PNCS	Navkar Corp. Ltd
PND	Pendra Road
PNDI	Pachandi
PNDM	Pennadam
PNDP	Pandillapalli
PNDR	Pandori
PNE	Prantik
PNF	Pangaon
PNFC	Pnfc Siding
PNGI	Panangudi
PNGM	Panchgram
PNGR	Pingora
PNHI	Panhai
PNHR	Panihar
PNI	Puraini
PNJ	Padriganj
PNK	Panki
PNKA	M/S. Naresh Kumar & Co. Pvt. Ltd.(served By Amta Station)
PNKD	Panki Dham
PNKI	Kudremukh Iron Ore Co Sdg, Panamburu
PNKR	New Kanpur For Dfccil Pvt Siding
PNM	Panyam
PNMB	Panamburu
PNMC	Mangalore Chemical and Fertilizers Siding
PNME	Parasnath
PNMN	New Mangalore Port B. G. Siding, Panamburu
PNMP	Adani Power Ltd. Siding (Pnmp) Served By Panamburu
PNN	Pani Mines
PNOB	M/S Nocci Balasore Infrastructure Company Ltd
PNOP	Pandu Parcel Siding,pandu
PNP	Panipat Jn
PNPI	Purunapani
PNPL	Panpali
PNPN	Panpana
PNPP	New Pahara
PNPR	Punnapra
PNPS	Kerala News Print Project Sdg, Pvrd
PNQ	Punkunnam
PNRA	Paniara
PNRD	Pauni Road P. H.
PNRR	New Ramva
PNS	Pillamshat
PNSA	Punsia
PNSD	Pangra Shinde Halt
PNSR	Pansar Bgpansar
PNSS	New Sujatpur By Dfccil
PNT	Panitola
PNTP	Private SDG of NTPC Gevra
PNTR	Pennathur Halt
PNU	Palanpur Jn
PNUG	Punpun Ghat Halt
PNUN	New Palanpur
PNV	Panevadi
PNVL	Panvel
PNVT	Pancharatna
PNW	Pundag
PNWN	Pachwan
PNWP	Patherdih Nlw Washery Siding
PNY	Pandi
PNYA	Paniya Hawa
PO	Parangipettai
POA	Palikona
POCP	Purushottampur Ocp Colliery Sdg.
POE	Pawapuri Road
POF	Piparsand
POHE	Pohe
POI	Ponpadi
POK	Pokran
POKL	Peokol
POL	Pinjra Pol
POLA	IOCL (Bg)(pvt) Ramnagar Siding, Silchar
POLB	Pol Siding, Bia
POLG	Pol Sdg. For M/S IOC Gaigaon
POM	Punthottam
PON	Ponneri
PONK	Pol Siding New Katni Jn
POO	Potlapadu
POR	Pipalda Road
PORA	Pora
POSA	Pol Siding , Aonla
POSB	Pol Siding, Bantra
POSG	Ordinance Depot Military Sdg, Pulgaon
POSN	Pol Siding, Najibabad
POT	Pothia
POTI	Potheri Halt
POU	Padrauna
POX	Pola-Patthar
POY	Pollachi Jn
POZ	Potul
PP	Puranpur
PPA	Pipra
PPAP	Adb Coal Handling Plant (adb SDG Paradeep)
PPB	Partabpura
PPBG	M/S. Paras Power & Coal Benefication Private Limited
PPC	Pipraich
PPCK	Pipalwali Chowk
PPCP	M/S Penna Cement Industries Ltd
PPCT	Penna Cements Ltd Siding Tadipatri
PPD	Piplod Jn
PPDA	Panchpatia Deoria Halt
PPDE	Pandu Pindara
PPDI	Pipradih
PPDP	M/S Pnp Maritime Services Ltd
PPE	Paintepur
PPEA	Paprera
PPF	Piplaj
PPG	Piploda Bagla
PPGP	Paradeep Phoshphate Ltd Gypsum Loading Pt.
PPGS	M/Sprayagrajpowergeneration Co. Limited,bara
PPGT	Princep Ghat
PPH	Pipri Dih
PPHA	Piphema
PPI	Pipariya
PPJ	Pophlaj
PPK	Pachpokharia
PPKD	Paprakund
PPLA	Piplai
PPLC	Pimpla Chaure Halt
PPLI	Pipli
PPM	Phirangipuram
PPN	Punpun
PPNI	Paras Pani
PPNS	Pappinisseri
PPO	Panposh
PPR	Pipar Road Jn
PPRH	Piprahan
PPRN	Piperan
PPS	Pipiliya Road
PPSJ	Pvt. Siding on Jrli Line No. 6, M/S. Prathama Steel Pvt Ltd
PPSM	Pardeep Port Manual Jron Ore Unloading Siding Under Ppt
PPSP	Pipavav Siding
PPT	Pirpainti
PPTA	Patliputra
PPTG	Paradeep Port Tippler Iron Ore Unloading Siding Unde
PPTN	Piprithan
PPTP	Paradeep Port Through Distance Siding
PPTR	Pushpattur
PPU	Piparpur
PPV	Pratapganj
PPVL	Pirappanvalasai
PPVS	Pipavav
PPW	Pachperwa
PPY	Papatapalli
PPZ	Peddempet
PQA	Pipla Halt
PQD	Pranpur Road
PQH	Pindkepar Halt
PQK	Pratap Khata
PQL	Pindlai
PQLB	Public Quarry Siding Bakudi Line No-1
PQM	Pakkam
PQN	Pariawan Kalakankar Road
PQS	Park Circus
PQT	Puniyavant
PQU	Parhana Mau
PQY	Pabli Khas
PQZ	Pundibari
PR	Parel
PRA	Phularitand Rly. Asstt. Siding, Katras Garh
PRAE	Palla Road
PRAR	Paror
PRB	Parbati
PRBG	Pratap Bagh
PRBR	Parsa Basuari
PRBZ	Parsa Bazar
PRCA	Perecherla
PRDG	Poradanga Halt
PRDH	Pirduleshah
PRDL	Paradol
PRDP	Paradeep
PRDT	Proddatur
PRE	Pahara
PRES	Pattabiram E Depot
PRF	Parsipur
PRG	Prayag
PRGA	Paharjagangaur Halt
PRGD	Perungudi
PRGL	Perungalattur
PRGN	Piduguralla New
PRGR	Pinargaria
PRGT	Pargothan
PRH	Powerpet
PRHS	Rly Pump House Siding Patiala
PRI	Pathri
PRIL	Reliance Industries Ltd Siding , L:alpur
PRJ	Prantij
PRJG	Parjang
PRJP	Raghunathpur Thermal Power Station of M/S Dvc
PRK	Parkham
PRKA	Parikha
PRKD	Powerkheda
PRKE	Purua Khera
PRKH	Parkanhatti
PRKL	Parikkal
PRL	Polur
PRLI	Parli Vaijnath
PRLN	New Prithala Jn (Dfccil)
PRLW	Parel Loco Workshop
PRM	Pirumadara
PRMB	Rashmi Metaliks Ltd At Bjmd.
PRMG	M/S. Rungta Mines Ltd. (at Gua)
PRN	Parauna
PRNA	Purnia Jn
PRNC	Purnia Court
PRND	Perinad
PRNG	Pritam Nagar
PRNL	Parsa Navroli H
PRNR	Porjanpur
PRNT	Periyanagathunai
PRP	Paharpur
PRPI	Pandhar Pavani
PRPL	Paradeep Phosphate Ltd
PRPM	Pt. Ram Prasad Bismil
PRR	Purulia Jn
PRRB	Prayagraj Rambag
PRSL	Pandrasali
PRSN	Parsa Nagar
PRSP	Prasadpur
PRSR	Paharsar
PRSS	Pratapnagar Store Siding
PRT	Panruti
PRTD	New Partapur
PRTK	Reliance Rail Terminal-Kanalus
PRTL	Pirtala
PRTN	Pratapnagar
PRTP	Partapur
PRTR	Putarra P. H.
PRTW	Pratap Nagar Workshop
PRU	Parlu
PRUR	Prithwirajpur
PRV	Pukkirivari
PRWA	Parwakhurd Halt
PRWD	Parewadi
PRWS	Pattabiram West Cabin
PRY	Paraiya
PRYJ	Prayagraj Jn
PRYJ2	Prayagraj Jn 2
PRZ	Parsa
PS	Paras
PSA	Palasa
PSAD	Adra Public Siding
PSAE	Purbasthali
PSAS	Pvt . Sdg. To Serve Andhra Cement Co Ltd, Scm
PSB	Parsabad
PSBD	Bua, G/Shed L N 04
PSBP	Sonepur Bazari Siding of ECL
PSBS	Private Siding To Serve Bokaro Steel Ltd
PSCE	Parascole E Colly. SDG
PSCR	M/S Crest Steel & Power Pvt Ltd
PSCS	M/S Shree Cement Limited
PSD	Parsoda
PSDA	Pasivedala
PSE	Pusauli
PSEB	Punjab State Elec Board Siding
PSEC	Parasea Colliery Sdg.
PSF	Patrasayer PH
PSFI	FCI Sdg, Gaya
PSFJ	Public Siding At Shunting Neck of M/S. FCI Siding
PSHI	Pol Siding For Hpc & IOC
PSHP	Parthasarathipuram
PSIA	Pol SDG For M/S IOC Akolner
PSIC	IOC Siding Bijapur
PSJ	Patasahi
PSJA	Jarangdih No. 1 and 2
PSK	Paradsinga Halt
PSKS	Pol Siding Katarsingh Wala
PSL	Parisal
PSLI	Parsoli
PSLP	Pasalapudi
PSME	Palasthali
PSMM	M/S. Shree Cement Ltd.
PSMR	M/S Reliance Cement Company Private Ltd.
PSN	Parsendi
PSNG	Sipat Super Tps, NTPC Ltd
PSNH	M/S National Thermal Power Corporation Ltd
PSNS	M/S Shree Balaji Steel and Metal Private Limited
PSO	Palsora Makrawa
PSOR	Public Siding of Railway
PSPC	Punjab State Power Corporation Limited (Pspcl) Served By Pakur
PSPG	Private Siding of M/S J. K.paper Limited
PSPH	Purushotampur Halt
PSPM	Sagardighi Thermal Power Plant Siding
PSPY	Prasannaya Palli
PSR	Pasraha
PSRC	Raipur Infracture Co Pvt Ltd
PSRS	In-Plant Yard of (parsa Kante Mines) M/S. Adani Track Mgmt Servs Pvt Ltd
PSRY	Pashwashraya
PSS	Padsali
PSSS	Shri Singaji Thermal Power Plant Siding
PST	Posoita
PSTA	Public Siding At Tatanagar
PSV	Parsneu
PSX	Ptnsngi Twn Hlt
PSY	Pasahi Kalan
PSZ	Parsauni
PT	Patli
PTA	Patiala
PTAB	Patia Halt
PTAE	Patuli
PTB	Pattambi
PTCR	Patancheru
PTD	Petlad Jn
PTE	Patiala Cantt
PTF	Palta
PTG	Patna Ghat
PTH	Patranga
PTHD	Patohan
PTHL	Pantihal PH
PTI	Patiali
PTJ	Podanur Jn
PTJT	Pvt. Sdg. of M/S. Tata Power Co. Ltd. At Jojobera
PTK	Pathankot
PTKC	Pathankot Cantt
PTKD	Patharkandi
PTKN	Pathankot (NG)
PTKP	Potkapalli
PTKR	Patipukur
PTLD	Patiladaha
PTLI	Pathauli
PTLR	Putlur Halt
PTM	Padalam
PTMJ	Line No. 6 of Jaruli Station Yard
PTMS	Pattabiram Military Siding
PTN	Patan
PTNR	Patelnagar
PTP	Patal Pani
PTPL	Petrapol
PTPR	Pratabpur Halt
PTPS	Patratu Vidyut Utpadan Nigam Limited, Patratu
PTPU	Prattiapadu
PTR	Patdi
PTRA	Patra
PTRD	Pataudi Road
PTRE	Patara
PTRJ	Patti Rajpura Halt
PTRL	Pathrala
PTRT	Pathrot
PTRU	Patratu
PTRX	Pataudi Road
PTS	Patansaongi
PTSB	M/S. Total Shipping & Logistics Pvt. Ltd. (Tslpl) Served By Bhankoda
PTSC	Parichaa Thermal
PTT	Putalapattu
PTTN	Pattan
PTU	Partur
PTWA	Patwara
PTYR	Patiyara
PTZ	Patsul
PU	Patchur
PUA	Pulla
PUC	Puduchattiram
PUCS	Il&fs Tamilnadu Power Company Ltd Siding
PUD	Phanda
PUDI	Pudi
PUDR	Podur
PUE	Palari
PUF	Pauta
PUG	Punggudi
PUHT	Pushkar Terminus
PUK	Pudukad
PUKK	Purunakatak
PUKS	Paru Khas
PUL	Rampura Phul
PUM	Pallippuram
PUMU	Penumarru
PUN	Pundi
PUNA	Pauniyan
PUNE	Pune Jn
PUO	Pir Umrod
PUPU	Pothulapadu
PUQ	Puranigudam
PURI	Puri
PUS	Phusro
PUSA	Pusla
PUT	Puttur
PUU	Punalur
PUW	Patuwas Mehrana
PUWA	Pauwara P. H.
PUX	Parasia
PUY	Phulaguri
PV	Pallavaram
PVD	Peddavadiapudi
PVG	Pavagarh
PVI	Peravurani
PVIT	M/S Vimala Infrastructure India Pvt Ltd
PVL	Pasupatikovil
PVM	Pattaravakkam
PVN	Puvanur
PVP	Parvatipuram
PVPT	Parvatipuram Tn
PVR	Pandharpur
PVRD	Piravam Road
PVSB	Vardhman Fabrics Siding, Budhni
PVU	Paravur
PVZ	Parvezpur
PW	Pirwa
PWA	Powai
PWBN	Pawai Brohmasthan Halt
PWCL	M/S Sai Wardha Power Generation Ltd.
PWCT	Parascole West Colly. SDG
PWDP	Pwd Rly Sdg, Pathankot
PWI	Padwaniya
PWK	Pipariya Kalan
PWL	Palwal
PWO	Perambur Works Goods Office
PWPS	Pandabeswar Public Siding
PWR	Pilwai Road
PWS	Phulwari Sharif
PWU	Paranur
PWXP	Pawani Kumarpur Halt
PXR	Palpara
PY	Perundurai
PYA	Pedapariya
PYD	Palliyadi
PYG	Prayag Ghat
PYGS	Prayagraj Sangam
PYHT	Prayahat Halt
PYI	Payli Halt
PYJE	Poyanje
PYK	Periyakottai
PYLA	Piyala Block Hut
PYM	Pandiyapuram
PYOL	Payyoli
PYQ	Prayagpura
PYV	Palayasivaram
PYX	Peyanapalli
PZA	Palavanthangal
PZV	Puzhuthivakkam
QBW	Qubarwala
QCAB	QCAB Station
QDN	Qadian
QG	Quazigund
QGT	Kolaghat
QLD	Quilandi
QLM	Kulem
QLN	Kollam Jn
QLNS	Food Corporation of India Grain Godown Sdg, Qln
QLR	Kallar station platform
QMRS	Kayamsar
QRP	Kila Raipur
QRS	Quarry Siding
QSBK	Quarry Siding Bakudi
QSR	Kansrao
QTP	Quatabpur
QTR	Kothara
QXR	Kuchesar Road
R	Raipur Jn
R1	R1 Station
RA	Ramparda
RAA	Barara
RAAN	New Barara
RABE	Rabale
RADE	Rabada
RAG	Raigir
RAGM	Rajagambiram
RAH	Ramgarh
RAHA	Raha
RAI	Raibha
RAIR	Rairakhol
RAJ	Rajpipla
RAJP	Rajapur Road
RAJR	Rajur
RAK	Ramkot
RAKD	Radhakund
RAKL	Rethorakalan
RAL	Repalle
RAM	Ramapuram
RAMA	Ramva
RAMP	Rampuri P. H.
RAMR	Ramaipur
RANG	Ramling
RANI	Rani
RAPR	Rapuru
RAPS	Ranigunge Pottery SDG Ranigunge
RAPU	Rampura
RAS	Ras
RASP	Rasipuram
RAU	Rau
RAWS	Rahatwas
RAY	Ray
RAYA	Raya
RBA	Rambha
RBCS	Ramachandrapuram
RBD	Rahimabad
RBG	Raybag
RBGJ	Roberts Ganj
RBH	Rajbandh
RBHR	Rabhra Halt
RBHT	R Block
RBIM	Bharatiya Reserve Bank Note Mudran Ltd
RBJ	Raibojha
RBK	Reoti B Khera
RBL	Rae Bareli Jn
RBN	Raghubans Nagar
RBNS	Rbns Sugar Mills Siding
RBQ	Ram Bishanpur
RBR	Ribada
RBS	Rupbas
RBZ	Rambhaddarpur
RC	Raichur
RCA	Rentachintala
RCAC	Rest Camp Siding, Ambala Cantt
RCD	Rajchandrapur
RCF	Rail Coach Factory
RCG	Rachagunnari
RCGJ	M/S The Ramco Cements Limited
RCGT	Richughutu
RCJ	Ranayala Jasnia
RCLH	Private Siding of Ramco Cements Limited
RCLM	GCT of M/S. Ramco Cements Ltd.
RCP	Ramachandrapur
RCPB	Reliance Cement Company Private Limited
RCPT	Ramachandrapuram Ts
RCR	Ratar Chattar
RCRA	Ramchaura
RCT	Raipur City
RCTC	Raghunathpur
RCXG	Rayatwari Colliery Sdg.
RD	Ram Dayalu Nagar
RDBP	Radhikapur Border Point
RDBR	Randia Baudpur
RDD	Rikhabdev Road
RDDE	Rathdhana
RDE	Rundhi
RDF	Radhagaon
RDG	Rayadurg
RDHP	Radhanpur
RDHR	Riddhapur
RDI	Kardi
RDJ	Randheja
RDK	Rashidpur Khori
RDL	Rudauli
RDM	Ramgundam
RDML	Rajdhar Siding
RDN	Rudain
RDP	Radhikapur
RDPS	Rajnandgaon Public Siding
RDR	Radhanagar
RDRA	Ramdevra
RDS	Ramdas
RDT	Ravtha Road
RDU	Radhamohanpur
RDUM	Rampur Dumra
RDV	Radha Balampur
RDY	Reddipalayam
RDYD	Ratlam Dn Yard
RDYV	Receipt and Despatch Yard, Vishakhapatnam Port
RE	Rewari Jn
REAI	Reasi
RECH	Rechni Road
RECY	Receiving Yard
REG	Regupalem
REI	Rithi
REJ	Rejinagar
REJN	New Rewari Jn Station
REM	Reddigudem
REMA	Rema
REN	Ren
RENH	Renhat
REP	Reddipalem
REPI	Rangepalli
RES	Rasauli
RET	Rentia
REWA	Rewa
RF	Rafaleshwar
RFCI	FCI Siding ,rajnandgaon
RFCR	M/S. Ramagundam Fertilizers and Chemicals Limited
RFGG	Govt Food Grain Sdg,fci
RFJ	Rafiganj
RFR	Rafinagar
RG	Rajghat Narora
RGA	Rajgoda
RGB	Ramganga
RGBD	Ramganga Bridge
RGBP	Rani Gaidinliu (Kaimai)
RGCR	Ratangarh Jn Cabin
RGD	Rajgir
RGDA	Rayagada
RGG	Radogarh
RGH	Ramgarhwa
RGI	Ramgiri
RGJ	Raiganj
RGJI	Rangjuli
RGL	Rengali
RGLI	Raghouli Halt
RGM	Rangapuram
RGMA	Rangamatia
RGNH	Raghunathgarh
RGO	Rotegaon
RGP	Raghunathpalli
RGPM	Raghavapuram
RGQ	Raigadh Road
RGS	Ringas Jn
RGSR	Rajkot Goods Shed
RGT	Rajghat Halt
RGTM	M/S Reliance Cement Company Pvt. Ltd.
RGU	Ragaul
RGV	Raghopur
RGX	Raghunathbari
RGZ	Rangra
RHA	Ranaghat Jn
RHAS	Crossing Cabin Ranaghat
RHBH	Rakesh Bagh Halt
RHE	Rakha Mines
RHG	Rajgarh
RHI	Rakhi
RHIH	Raipur Handling & Infracture Pvt. Ltd
RHMA	Rahama
RHMP	Rahamatpur
RHN	Roshanpur
RHNE	Rohini
RHO	Rohna
RHOT	Rohna Town
RHR	Rajhura
RHU	Rahon
RHW	Rhra Ghalughra
RIBP	Ramakunda Ibp (Halt)
RICD	Inland Container Depot Siding
RID	Ridhore
RIG	Raigarh
RIGA	Riga
RIKA	Ratikheda
RIKD	Rishikund
RIM	Rajim
RINN	M/S. Rashtriya Ispat Nigam Ltd.
RINS	NTPC Sdg, Rihand
RIS	Rishra
RJ	Rawat Ganj
RJA	Rajnagar
RJAK	Raj Nagar K Halt
RJAP	Rajapur
RJB	Rajabera
RJC	Rajsitapur
RJCB	Rajnagar Colliery SDG Bjri
RJD	Raj-Pardi
RJG	Rajgram
RJGR	Raj Athgarh
RJI	Rajawari
RJIN	Rajuri
RJJN	Rajajan Halt
RJK	Raja ka Sahaspr
RJKN	R & Ubm Siding of M/S Jindal Steel Limited
RJL	Rajmahal
RJLA	Rajla Halt
RJLK	Rajalukah
RJMA	Rajomajra
RJMP	Rajmalpur Road
RJN	Rajnandgaon
RJO	Rajendra Pul
RJP	Razampeta
RJPB	Rajendra Nagar Terminal
RJPM	Rajapalayam
RJPS	Rajgram Public Siding
RJQ	Rajendranagar
RJR	Rajaldesar
RJS	Rajiyasar
RJSG	Rajur Colliery Sdg.
RJT	Rajkot
RJU	Rajula City
RJUA	Rajura
RJW	Rajevadi
RJY	Rajamundry
RK	Roorkee
RKAE	Ramkistopore
RKB	Raika Bagh
RKD	Rukadi
RKDI	Raukheri
RKG	Rattoke Gudwara
RKH	Rakhiyal
RKI	Ramkanali Jn
RKJE	Rakhitpur
RKK	Ratangrh Knkwal
RKL	Ramkola
RKM	Raja ki Mandi Jn
RKMP	Rani Kamalapati
RKN	Rati ka Nagla
RKO	Ramakistapuram Gate
RKR	Ranikund Rarah
RKS	Sarai Rani
RKSG	Rawanwara Khas Colliery Sdg.
RKSH	Rishikesh
RKSI	Rakshi
RKSN	Rajkharsawan Jn
RKSO	RKSO Station
RKWO	RKWO Station
RKX	Rukhi
RKY	Kothariya
RKZ	Rajkiawas
RLA	Rajula Jn
RLCM	Rajdhar Line No.2 CCL Sdg.
RLD	Randala
RLE	Railey English Halt
RLG	Relangi
RLJC	Ranital Link Jn Cabin
RLK	Rohal Khurd
RLL	Regadipalli
RLO	Rayalcheruvu
RLP	Harlapur
RLPL	Rama Lingaya Palle
RLR	Raila Road
RLS	Rmna Albel Sngh
RLSP	Ratlam Pol Sdg, Ratlam
RLT	Ralapet
RLW	Repalliwada
RLX	Ramanujam Palli
RM	Rajmane
RMA	Ramganj Mandi Jn
RMAR	Ram Mandir
RMB	Rampura Beri
RMBG	Ramghat Halt
RMBK	R. E.military Siding, Barkakana
RMC	Ram Chaura Road
RMD	Ramanathapuram
RMF	Ramna
RMGD	Ramgad
RMGJ	Ramganj
RMGM	Ramanagaram
RMH	Rangmahal
RMJ	Ramrajatala
RMJC	M/S. JSW Steel Ltd
RMJK	Ram Nagar
RML	Rompalle PH
RMM	Rameswaram
RMN	Raman
RMNP	Ramannapet
RMNR	Rahmatnagar
RMO	Ramakona
RMOA	Raimoha
RMP	Rahimatpur
RMPB	Rampur.
RMPH	Rampahari
RMPR	Rampur Halt
RMQ	Ramriramri
RMR	Ramnagar
RMRB	Ramnagar Bengal
RMSR	Ramsinghpur
RMT	Ramgarh Cantt
RMTR	Re-Mount Road
RMU	Rampur
RMUY	Raw Material Unloading Yard, Vsps
RMV	Ramavarappadu
RMW	Roshan Mau
RMX	Ramsar
RMY	Rukmapur
RMZ	Routhpuram Halt
RN	Ratnagiri
RNA	Rohana Kalan
RNAN	New Rohana Kalan
RNB	Ranpura
RNBD	Rana Bordi
RNBT	Rahen Bata
RNC	Ranchi
RNE	Ranjani
RNEY	Radhanagar Exchg. Yd. To Serve M/S. Iisco (SAIL) Sdg./Burnpur
RNG	Raniganj
RNGG	Rangaliting
RNGN	Ranigaon
RNGR	Rainagar PH
RNGS	Rajur New Goods Shed Served By Rajur
RNH	Runkhera
RNI	Rangapani
RNIR	Raj Narainpur
RNIS	Ranolishishu
RNJ	Runija
RNJD	Ranjangaon Road
RNJP	Ranajitpura
RNKA	Runkuta
RNL	Ranala
RNMD	Runnymede
RNN	Rajankunti
RNO	Ranoli
RNPR	Rupnarayanpur
RNQ	Renukut
RNR	Ranibennur
RNRD	Ranipur Road
RNSG	Indian Navy Store Depot Military Siding, Kurla Jn
RNT	Ranthambhore
RNTE	Ramanand Tiwari Halt
RNTL	Ranital
RNU	Ratnapur
RNV	Raniwara
RNW	Renwal
RNX	Ranipatra
RNY	Rangiya Jn
ROA	Rusera Ghat
ROB	Robertson
ROHA	Roha
ROHN	Rohednagar Halt
ROI	Reoti
ROK	Rohtak Jn
ROL	Rajuli
ROP	Rupsa Jn
RORA	Rora
ROS	Rajosi
ROU	Rourkela
ROZA	Roza Jn
RPAN	Rangapara North
RPAP	Ratnipora
RPAR	Rupnagar
RPB	Rupasibari
RPBC	Rayanapadu "b" Cabin
RPBP	Rampur Bampur
RPCA	Rompicherla
RPCK	M/S Reliance Petroleum Siding -Kanalus (solid Cargo Siding)
RPD	Rupaund
RPGU	Rasulpurgogamau
RPH	Rampur Hat
RPHR	Raipur Hariyana Jn
RPI	Rupaheli
RPJ	Rajpura Jn
RPK	Ravalpalli Kalan
RPL	Reddipalle
RPLW	M/S Ratanindia Power Ltd
RPLY	Rupauli
RPM	Royapuram
RPMN	Rampurmani Haran
RPMY	Rampurhat Marshalling Yard
RPNN	Rampur Naikin
RPO	Rawatpur
RPOS	Raichur Public Oil Siding
RPP	Ranu Pipri
RPR	Raghunathpur
RPRD	Rupra Road
RPRL	Raparla Halt
RPSC	Rudrapur Sidcul Halt
RPSG	Ranavav Public Sdg, Ranavav
RPT	Ranipettai
RPUR	Ratanpur
RPV	Rajapatti
RPWN	Rpwn
RPY	Rupai
RPZ	Rana Pratap Nagar
RQJ	Raninagar Jalpaiguri
RQP	Radhakishorepur
RR	Richha Road
RRAL	Rure Asal
RRAP	Ramkanali Rly Asst Pvt SDG
RRB	Birur Jn
RRD	Reay Road
RRE	Rahui Road
RRGA	Rangareddy Guda
RRI	Rahuri
RRJ	Ramaraju Palli
RRL	Rewral
RRME	Ranchi Road
RRNH	Ramroop Nagar Halt
RRP	Rairangpur
RRPM	Revoor Ramapuram
RRS	Raghuraj Singh
RRU	Rayaru
RRW	Roranwala
RS	Risia
RSA	Risama
RSBH	RSBH Station
RSBR	Ras Babra
RSBS	Sbj Relief Rly Siding Rajpura
RSC	Ramganga South Cabin
RSCM	Rajdhar Silo Line CCL Sdg.
RSCR	Rajhaura Colliery Siding
RSCS	Rajgaon Stone Co. Sdg.
RSD	Raipur Store Depot
RSDG	Rajhara Siding
RSG	Ramsagar
RSH	Ratanshahar
RSI	Raisi
RSJ	Rayser
RSKA	Rajsunakhala
RSLR	Rasulpur
RSM	Rasmara
RSME	Raswan
RSMN	Ramgovindsingh Mahuli Halt
RSNA	Rasana
RSNR	Rai Singh Nagar
RSR	Rasra
RSRI	Raishree
RSRS	Smu Relies Rly Siding Rajpura
RSWN	Narayanpur Tatwara
RSWT	Ramgarh Shekhawati
RSY	Rushabhdev Upariyala (russa Road C. B)
RSYI	Rasayani
RT	Rohat
RTA	Ruthiyai Jn
RTB	Raja Talab
RTBR	Ratabari
RTD	Ratlam 'a' Cabin
RTG	Rangtong
RTGH	Ratangarh Jn
RTGN	Ratangaon
RTGR	Ratnagiri Road
RTI	Raoti
RTJ	Rantej
RTK	Ramtek
RTM	Ratlam Jn
RTMC	Ratlam Siding
RTME	Ratlam East Cabin
RTMN	Ratlam New
RTN	Retang
RTP	Ratanpura
RTPM	Rayalaseema Thermal Powerplant and Siding
RTPR	Rtp Siding
RTR	Ramnathpur
RTRA	New Ramnath Pur
RTS	Rehta
RTU	Ratan Sarai
RTWS	Rahatwas
RTZ	Ratona
RU	Renigunta Jn
RUB	Rasulabad
RUBN	New Rasulabad
RUG	Rajlu Garhi
RUI	Rukni
RUJ	Ranuj
RUKH	Rukhai Halt
RUL	Ravli
RUM	Rupamau
RUP	Rupahigaon
RUPC	Rudrapur City
RUR	Ranpur
RURA	Rura
RUSD	Runnisaidpur
RUSG	Rudrampur Incline No.5 Colliery
RUT	Ratnal
RUYD	Ratlam Up Yard
RV	Raver
RVD	Ravikampadu
RVG	Revelganj Ghat
RVH	Raipur R-V Block Hut
RVJ	Ravli Jn Cabin
RVK	Raja Bhat Khawa
RVKH	Ravindrakhani
RVS	Ravanasamudram
RVSJ	Rashtriya Ispat Nigam Ltd (Vsps)
RW	Rankua
RWA	Rautara
RWF	Rail Wheel Factory Siding
RWGR	Rajarappa Washery
RWH	Rowriah SDG
RWJ	Rawania Dungar
RWL	Raiwala
RWO	Ranavav
RWOQ	Ranavav Quarry Siding
RWS	Raipur Work Shop
RWTB	Rowta Bagan
RXL	Raxaul Jn
RXM	Rooma
RXN	Ramsan
RXR	Rangapahar
RXRX	Rangapahar Crs
RXT	Raxaul Nepal Siding
RXUL	Raxaul Jn.(mg)
RXW	Ratangarh West
RY	Rayaka
RYC	Rayakkottai
RYD	Reception Yard, Waltair Marshalling Yard
RYGA	Rayanguda
RYL	Rahiiyol
RYM	Ramidi Halt
RYP	Rayanapad
RYPS	Rayanapaduws
RYS	Rasuriya
RYT	Rayat Pura
RZJ	Razaganj
RZN	Rauzagaon
S	Shrirangapatna
S1	S1 Station
SA	Salem Jn
SAA	Sathiaon
SAB	Santamagulur
SABD	Salabad
SAC	Sanichara
SACH	Suchitra Centre
SAD	Sonada
SADL	Sadlasadlasadla
SADP	Saidapur
SAE	Simaria
SAES	Sae (Indian) Sdg. Deori
SAF	Salkhapur
SAG	Sangrur
SAGM	Sagma Jn
SAGR	Shrirajnagar
SAH	Saphale
SAHA	Sarahula
SAHI	Sathi
SAHL	Saheli
SAHP	Sahijpur
SAHR	Saheri
SAHT	Samhuta Halt
SAI	Sarai
SAIK	Rashtriya Ispat Nigam Ltd (Vsps)
SAIL	SAIL Siding, Guh
SAIN	Steel Authority of India Ltd
SAIP	Steel Authority of India Sdg, Pilamedu
SAIT	Steel Authority of India Siding
SAJH	Sahja Halt
SAK	Sak Bahadurpur
SAKA	Simariya Kajanwada
SAKD	Suprakandi Halt
SAL	Salwa
SALE	Salar
SALI	Saheli
SALR	Salur
SAMN	Samni Jn
SAMT	Salem Market
SAN	Sandila
SANG	Sairang
SANH	Sanha Halt
SANI	Shanki
SANK	Sank
SANR	Sardarnagar
SAO	Sagoni
SAP	Sattenapalle
SAPD	Sanapadar PH
SAPE	Sape Wamane
SAPR	Sarangpur Road
SAPT	Tp No. 7/11 (sugapahari Halt)
SAR	Shahzad Nagar
SARR	Sidhaouna Rampur Halt
SARY	Saraiya Halt
SAS	Sheodaspura Padampura
SASG	Sasan Gir
SASN	SAS Nagar Mohali
SASR	Sausar
SAT	Sant Road
SATP	M/S. Steel Authority of India Ltd. ,panki
SATR	Satar Halt
SAU	Sanand
SAUN	New Sanand North Jn
SAUS	New Sanand South Jn
SAV	Savda
SAVR	Saravaram
SAW	Suriawan
SAWN	Sohansra
SAY	Sayama
SB	Sarai Bhopat
SB04	Mana P. H
SBB	Sahibabad
SBBJ	Sri Bala Bramareshwara Jogulamba
SBBP	Sardarballabh Bhai Patel
SBC	KSR Bengaluru
SBCT	South Balanda Colliery Siding (spur-1 & 2) of MCL
SBD	Sleemanabad Road
SBDP	Sabdalpur Jn
SBDR	Sonbhadra
SBE	Sorbhog Jn
SBEM	Engg. Workshop (MG) SDG Sabarmati, Sabarmati Jn
SBES	Engg. Workshop (BG) SDG Sabarmati, Sabarmati Jn
SBG	Sahibganj Jn
SBGA	Shravanabelagola
SBGB	Sutei Badegan
SBGG	Sahibganj Public Siding
SBGN	Sisibargaon
SBGR	Subhas Gram
SBH	Sulebhavi
SBHN	Shri Bhavnath
SBHR	Subrahmanya Road
SBI	Sabarmati Jn
SBIB	Sabarmati BG
SBID	Sabarmati D Cabin
SBIS	Sabarmati South Bridge Cabin
SBJ	Sarai Banjara
SBJN	New Sarai Banjara Jn
SBK	Shahbaz Kuli
SBKT	Sendra Bansjora Colliery Siding
SBL	Sabalgarh
SBLJ	Shri Balaji
SBLM	Loco MG Sdg, Sabarmati
SBLP	Sounda B, Line No. II Siding CCL
SBLT	Shri Bhadriya Lathi
SBM	Sonbarsa Kcheri
SBNH	Shri Bhavnath
SBNM	Subarnamrigi
SBNR	Shri Vijainagar
SBO	Sabaur
SBP	Sambalpur Jn
SBPD	Sambalpur Road
SBPS	Shaheed Baba Parav Halt
SBPY	Sambalpur City
SBR	Sambhar Lake
SBRA	Sarbahara
SBRM	Sabroom
SBS	Sangrana Sahib
SBSM	Signal Workshop MG Siding, Sabarmati
SBSS	Signal Workshop BG Siding, Sabarmati Jn
SBT	Sabarmati Jn
SBTA	Sabarmati 'a' Cabin
SBTF	Sabarmati F Cabin
SBTG	Sabarmati General Stores Siding.
SBTI	Sambheti
SBTJ	Sdd Bishnathganj
SBV	S Bhakhtiyarpur
SBW	Shewbabudih
SBWT	M/S Sai Balaji Warehousing & Logistics Private Limited
SBY	Solan Brewery
SBZ	Siswa Bazar
SC	Secunderabad Jn
SCA	Salchapra
SCC	Sitapur Cantt
SCCR	Saurashtra Cement Ltd Sdg, Ranavav
SCDG	Dipika II SDG
SCDS	Sleeper Creosoting Depot Rly SDG
SCE	Senchoa Jn
SCES	Nhpc Siding Senchoa (P) (Bg)(senchoa)
SCGP	M/S Maharashtra Cement Plant (a Unit of Shri Cement Ltd.) At Patas
SCGR	M/S Shree Cement East Private Limited GCT Served By Ramkanali
SCH	Sachin
SCI	Sanchi
SCIC	M/S Sidcul CONCOR Infra Company Ltd. Pft Siding
SCKR	Salichauka Road
SCL	Silchar
SCLN	SECR Crew Lobby Nagpur
SCLS	M/S. Shiv Carriers Roadways Pvt. Ltd. At Sukhpur
SCM	Simhachalam
SCMM	M/S Saoner Coal Mines
SCMN	Simhachalam North
SCMS	Trimulgerry Military Sdg, Secunderabad
SCN	Sondha Road
SCO	Satuna
SCOB	S. C.o. B. Siding Iisco
SCP	Sirnapalli
SCPD	Suchipind
SCPM	NALCO Smelter/Captive Power Plant
SCPR	Shyama Charanpur HAL
SCPS	Saurashtra Chemicals SDG Porbundar
SCPT	Sirka Siding
SCQ	Sham Chaurasi
SCR	Riga Sugar Corpn. Sdg, Rega
SCRM	Ramakrishnapuram Mines For Singareni Collieries
SCSC	Seru Bera Siding
SCSK	Surakachar Colliery Siding
SCT	Sengottai
SCTP	Saurashtra Chemical Thermal Plant SDG Bg, Porbandar
SCU	Pure Sitalpur Colliery SDG
SCV	Sukhchain
SCW	Swang Washery Siding
SCY	Sachiwalay (Halt)
SD	Sidhauli
SDAH	Sealdah
SDAM	Sundhiamau
SDB	Shahabad
SDBH	Sindri B. H
SDBR	Shedubhar
SDC	Saidabad
SDCO	DCOS Rly Sdg, Shakurbasti
SDD	Sindhawadar
SDDK	Store Depot Siding For Diesel Loco Shed (Departmental)
SDDN	Siddharth Nagar
SDE	Sadisopur
SDF	Sudsar
SDG	Sahadai Buzurg
SDGH	Sri Dungargarh
SDGM	Sardargram
SDH	Saradhna
SDHA	Sidhari Halt
SDHN	New Saradhana
SDHR	Sandhanidhar
SDHS	Sidhirsai
SDI	Sagardighi
SDL	Shahdol
SDLE	Swadinpur
SDLK	Sundlak
SDLP	Sadulpur Jn
SDM	Surareddipalem
SDMD	Sudamdih
SDMG	Sm and Io Siding
SDMK	Sidmukh
SDN	Sholavandan
SDNR	Seydunganallur
SDPH	Sardar Patel Halt
SDPN	Sindpan
SDPR	Sardar Patel Road
SDPT	Sedarampattu
SDRA	Sudharana
SDRN	Shendurni
SDS	Sadulshahr
SDSA	Supply Depot Siding, Ambala Cantt
SDSG	Jaypee Cement Corporation Ltd
SDSL	Sandasal
SDSS	Saraya Distillery (BG) SDG Sardarnagar
SDT	Sadat
SDUA	Sadura
SDUL	Sripur No1 Colly. SDG
SDV	Somidevipalle
SDVL	Soldevanahalli
SDWR	Sidhwar
SDY	Sadhoo Garh
SDYS	Ap Dairy Development (snagam Dairy)
SDZ	Sindhar
SE	Semla
SEB	Son Nagar
SEBD	Private Siding of M/S Vedanta Limited
SEBL	New Son Nagar Link Jn
SEBN	New Son Nagar Jn
SECL	Robertson Siding of SECL
SED	Shedbal
SEDS	Sangidalam East SDG Rjl
SEE	Sonpur
SEG	Shegaon
SEGM	Sevagram
SEH	Sehore
SEI	Shendri
SEJ	Sarkhej
SEL	Sankrail
SELU	Selu
SEM	Sedam
SEMK	Shemtikhar
SEN	Senapura
SEO	Seohara
SEP	Sodpur
SEPN	Sepon
SEPR	Sherpur
SEQ	Sekha
SER	Samayanallur
SES	Semari
SET	Settihally
SEU	Sendra
SEV	Sithalavai
SEW	Sehal
SEX	Seroni Road
SEY	Seoni
SF	Settigunta
SFA	Sanhera Halt
SFC	Saintala
SFCG	Food Corporation of India Siding, Sevur
SFCK	Silo-FCI Siding (pvt), Katihar
SFCS	FCI Siding Saharsa
SFDE	Safidon
SFE	Sanodiya
SFF	Sunera Pirkheri
SFG	Subedarganj
SFH	Safedabad
SFHX	Sf Siding , (FCI) Harduaganj
SFK	Sikir
SFM	Sunam Udham Singh Wala
SFMU	Sunam Udham Singh Wala
SFNR	Saifinagar Halt
SFPR	Safipur
SFR	Safrai
SFS	Safiasarai Halt
SFW	Sarangpur
SFX	Safilguda
SFY	Shajapur
SFZ	Shinduriya Kachari
SG	Shahgarh
SGA	Shergarh
SGAC	Sogariya
SGAM	Sareigram
SGBA	Sir Gurudas Banerjee
SGBB	Bhilai Marshalling Yard
SGBJ	Surgaon Banjari
SGC	Saongi
SGD	Songadh
SGDM	Sigadam
SGDN	Sangaldan
SGDP	Sagadapata
SGDV	Somaguddu H
SGE	Sankaridurg
SGES	Bharat Petroleum Corp Sdg, Shankagiri
SGF	Sangat
SGFG	FCI Siding (BG) Sabarmati
SGG	Sultanganj
SGJ	Safdarganj
SGK	South Govindpur
SGKM	Srungavruksham
SGL	Sagauli Jn
SGLA	Sangola
SGLM	Sengulam
SGM	Solagampatti
SGND	Shrigonda Road
SGNL	Sanganal
SGNR	Shri Ganganagar
SGO	Saugor
SGP	Sohagpur
SGPA	Tp No. 6/3 (sugapahari Halt)
SGPS	Slag Granulated Plant
SGR	Sangameshwar Road
SGRA	Sangaria
SGRD	Saragaon Road Halt
SGRE	Salgare
SGRL	Singrauli
SGRM	Singaram
SGRP	Singhirampur
SGRR	Sanger
SGS	Shoghi
SGSR	M/S. Sadguru Irrigation Systems Ltd.
SGTP	Sanjay Gandhi Thermal Power Station Siding
SGTY	Sankrail Goods Terminal
SGUJ	Siliguri Jn
SGUT	Siliguri Town
SGV	Saragchni
SGW	Singhawal
SGWF	Whitefield Satellite Goods Terminal
SGWK	Serai Kela Glass Works Siding, Kandra
SGYW	Singriyawan Halt
SGZ	Shamgarh
SHAD	Shahad
SHAN	Srinivasa Nagar
SHB	Shahibag
SHBA	Sahebtala Halt
SHBC	Sibaichandi
SHBL	Shiblun
SHC	Saharsa Jn
SHCF	Saharsa Jn (MG)
SHDM	Shahbad Marknda
SHDR	Shadhoragaon
SHE	Seoraphuli
SHEO	Shisho Jn
SHER	Sher
SHF	Shirud
SHG	Shahganj Jn
SHGN	Shri Ghasinagar
SHH	Shapur
SHHT	Singhaul Halt
SHI	Singanallur
SHIH	Sarhari
SHIT	Salhaitola P. H.
SHIV	Shindawane
SHJ	Sahaspur Road
SHJP	Sahajipur Halt
SHK	Sheikpura
SHKL	Shankrul
SHKY	Saharsa Kutchery HAL
SHL	Sadhli
SHLK	Sholaka
SHLT	Shalashah Thana
SHLU	Shelu
SHLV	Selavi
SHM	Shalimar
SHMI	Shiroor
SHMR	Shyamsunder
SHN	Suchan Kotli
SHNG	Shivnagar
SHNR	Shadnagar
SHNS	Sheikhpura Railway Siding
SHNX	Sheosingh Pura
SHR	Sihora Road
SHRA	Shahera
SHRD	Saij Sertha Road
SHRG	Sri Ramgarh Halt
SHRM	Sharma
SHRN	Sant Hirdaram Nagar Jn
SHSG	Shanti Khani Colliery
SHSK	Saharsrakund
SHT	Sahri Halt
SHTS	Sambhal Htm Sar
SHTT	Silghat Town
SHU	Sholinghur
SHV	Shivani
SHW	Samhon
SHWL	Sahuwala
SHX	Shukarullahpur
SHYP	Sakarayapatna
SHZ	Summer Hill
SI	Sonalli
SIA	Shivlankha
SIBR	Shribar
SIC	Sonik
SICD	Salem Market - Container Rail Terminal
SICY	Saheed Ishwar Chowdhary Halt
SID	Siddhpur
SIDG	Siddapur Grama
SIDP	Siddapur Halt
SIE	Siddampalli
SIF	Sirli
SIGA	Shantigrama
SIHI	Shihori
SIHO	Siho
SIHT	Sameli Halt
SII	Sitimani
SIJU	Siju
SIK	Sikkampatti Halt
SIKA	Sikka
SIKD	Sikroda Kwanri
SIKI	Sulikeri
SIKR	Sikar Jn
SIL	Sakhi Gopal
SILE	Sile
SILO	Silao
SILP	Silpara
SILR	Silari
SIM	Shri Amirgadh
SIMN	New Shriamirgadh
SIMR	Srirampur F
SIN	Sion
SINA	Sri Nagar
SINI	Sini Jn
SINR	Sinor
SIOB	Samakhiali B G
SIOC	Oil Lay Bye Siding, Sanathnagar
SION	Sion
SIP	Suraimanpur
SIPA	Singhpokharia
SIPI	Saiphai
SIPR	Sihapar
SIPT	Siddipet
SIQ	Sarkoni
SIR	Sirhind Jn
SIRA	Sirhiltara
SIRD	Sird
SIRL	Shirala
SIRN	Sirran
SISB	Sunflag Iron and Steel Co
SISM	Singuli Shyam
SISN	Sisauna
SISS	Simboli India Ltd Siding
SIU	Singur
SIVN	Sivnar Halt
SIW	Shiravade
SIWT	Sayaji Iron Works Querry Pvt Ltd. Sdg, Timba Road
SIY	Sirri
SIZ	Shrikhanda
SJA	Sijua
SJCT	Spur-3 & 4 of Jagannath Colliery Siding of M/S MCL
SJD	Saljadasaljada
SJDA	Sanjuje da Arey
SJDR	Sri Jhadeshwar Road
SJER	Sanjarpur
SJF	Sajanvar Road
SJGH	Sarai Jagdish
SJGM	Sanjay Gram
SJHG	Sj Halt Gopalpur
SJJ	Sanjha
SJKL	Surja Kamal
SJL	Sgm Jagarlamudi
SJM	Sajuma
SJMA	Sanjamala
SJN	Sanjan
SJNP	Sujanpur
SJP	Shujalpur
SJPA	Sujalpur PH
SJPM	Sujata Puram Halt
SJPR	Surjyapur
SJQ	Surajpur Road
SJRR	Sajherpar
SJS	Shamlaji Road
SJSM	Salemgarhmasani
SJSQ	Pvt SDG of M/S Sindh Jivan Stone Works. Bhw
SJT	Shujaatpur
SJTN	New Shujatpur
SJTR	Sojitra
SJV	Sajhauli Halt
SJVP	Sanjivaih Park
SJWB	Sumerpur Jawai Bandh
SJWT	Silo At Spur-3 & 4 of Jagannath Washery Siding of M/S MCL
SK	Saakhun
SKA	Sikandra Rao
SKAD	Suprakandi Halt
SKAP	S. K.para
SKAR	Sakariya
SKB	Shikohabad Jn
SKBN	Silakeri
SKBR	Shankarpur Bhadaura
SKDA	Sukinda
SKDG	Shukradas Gram Halt Devachak
SKDM	Sikroda Mina
SKEN	Sukhshena Halt
SKF	Sakhoti Tanda
SKFN	New Sakhoti
SKG	Saktigarh
SKGH	Saktesgarh
SKHK	Sukhasan Kothi Halt
SKHR	Sikhera Mb Halt
SKHV	Sukhovi
SKI	Sakri Jn
SKIP	Shikaripara
SKJ	Sahibpur Kamal Jn
SKJS	Sri Krishna Janam Sthan
SKK	Sikkal
SKKE	Sekerkote
SKL	Singaperumal Koil
SKLI	Sukli
SKLP	Shankarpur
SKLR	Sakleshpur
SKM	Singarayakonda
SKN	Srikrishn Nagar
SKND	Sukinda Road
SKNN	New Sakhun Crossing Station
SKNP	Sarkanpur
SKNR	Shakar Nagar
SKP	Shankarpalli
SKPA	Sri Kalyanpura
SKPI	Sikripai
SKPR	Sikarpur P. H.
SKPT	Somanayakkanpti
SKQ	Sikandarpur
SKR	Sakhpur
SKRI	Sikaria
SKS	Salekasa
SKSO	Sikosa P. H.
SKSS	M/S. Sks Power Generation (c. G.) Ltd. /Spbc
SKT	Sakti
SKTN	Shaktinagar
SKU	Sikroda
SKVL	Sankval
SKW	Sheikhupur
SKX	Sarkara
SKY	Shikara
SKZR	Sirpur Kaghaznagar
SL	Surathkal
SLB	Salboni
SLBN	Salai Banwa
SLBS	Salsala Bari
SLCC	SECL Chhal Mines
SLCP	Sayal Colliery Siding
SLCS	Shivpoor Line No.1 CCL Siding
SLD	Sakaldiha
SLF	Silli
SLG	Simlagarh
SLGE	Sulerjavalge
SLGH	Shelgaon
SLGM	Sankaralingapuram
SLGR	Simaluguri Jn
SLH	Siliari
SLHA	Salhana
SLHI	Shilhauri Halt
SLHP	Sulah Hmchl Pdh
SLI	Sangli
SLIA	Salaiya
SLJ	Sakrigali Jn
SLJG	Sakrigali Ghat Line Public Siding
SLJR	Salgajhari
SLKN	Sandal Kalan
SLKR	Salka Road
SLKX	Salakati
SLM	Somalapuram
SLME	Salem East
SLN	Sultanpur
SLNA	Salauna
SLNG	Sultanpur Gram
SLNK	Sultanpur Karnataka
SLO	Samalkot Jn
SLOG	SECL Load Out System (laxman Project of Secl)
SLON	Salona
SLOR	Seloo Road
SLP	Salpa
SLPM	Shivalingapuram
SLPR	Silpaprabesh
SLR	Salogra
SLRA	Sarala
SLRD	Surla Road
SLRP	Salarpur
SLRW	Shelarwadi
SLS	Salanpur
SLSP	Shivpoor Line No.4 CCL Siding
SLT	Silaut
SLTC	Chettinad Cement Corporation Private Ltd Siding
SLTH	Sillakkudi
SLU	Sasalu
SLV	Sandalpur
SLVK	Sri Lakshmi Venkateshwara Warehousing and Pft Private Limited
SLW	Sohwal
SLWR	Silawar
SLX	Seleng Hat
SLY	Samalpatti
SLZ	Solari
SM	Samsi
SMAE	Samudra Garh
SMAP	Shamnapur
SMBH	Salim Pur Bihar (H)
SMBJ	Shri Mahabirji
SMBL	Simbhooli
SMBR	Sumber
SMBX	Samba
SMC	Samnapur
SMCK	Shyam Chak
SMCP	Simen Chapari
SMD	Cheran Mahadevi
SMDC	Sawai Madhopur D Cabin
SMDM	Samudram
SMDP	Shahabad Md. Pur
SMDR	Simodara
SMDT	Semmandappatti
SME	Shimoga
SMER	Private Siding of M/S Shyam Metalics and Energy Limited
SMET	Shimoga Town
SMF	Samar Gopalpur
SMG	Shahamatganj
SMGR	Samaguri
SMH	Simraha
SMI	Sitamarhi Jn
SMIA	Sitamarhi Jn (MG)
SMID	Sabarmati Diesel Shed
SMK	Samalkha
SMKR	Sham Kauria
SMKT	Somankatti
SML	Shimla
SMLA	Samlaya Jn
SMLG	Shimili Guda
SMLI	Swamihalli
SMLT	Samloti
SMM	Saliyamangalam
SMND	Sarmatanr
SMNE	Somatne
SMNH	Somnath
SMNN	Shri Makri Nath Naga
SMO	Semapur
SMP	Shambhupura
SMPA	Shyampura
SMPB	M/S Shree Mega Power Siding
SMPN	New Shrimadhopur Crossing Station
SMPR	Shri Madhopur
SMQL	Shamli
SMR	Samdhari Jn
SMRL	Samarala
SMRR	Sumreri
SMSR	Samaswara
SMSS	Star Paper Mills Siding ,sre
SMT	Salamatpur
SMTA	Samuktala Road
SMTG	Saheed Matangini
SMTL	Simariatal
SMTN	Somthan
SMU	Sambhu
SMUN	New Sambhu Jn
SMV	Sumaoli
SMVB	SMVT Bengaluru
SMVJ	Shri Mahaveerji
SMWA	Someshwara
SMX	Simurali
SMYD	Sabarmati Yard
SMZ	Sarai Mir
SN	Sukna
SNA	Sadanapura
SNAD	Saniyad
SNAG	New Goods Complex Sanatnagar
SNAP	Sona Arjunpur
SNAR	Srinagar
SNB	Satnaur Badesron
SNBD	Sunderabad
SNBR	Sonuabary
SNC	S Narayan Chhapia
SNCA	Singra
SNCR	Sanpada
SND	Sondimra
SNDA	Sandhia
SNDD	Sindhudurg
SNDI	Sendurai
SNDP	Sandispur
SNDT	Sindri Town
SNDY	Sandai
SNE	Shenoli
SNEC	Surendranagar East Cabin
SNF	Sanatnagar
SNFC	Associated Cement Co. S. Siding (Sindri)
SNFP	Sindri Assisted SDG
SNGDP	Santhagudipadu
SNGI	Shingnali
SNGN	Sanganer
SNGP	Singhpur
SNGR	Sanganapur
SNH	Saunshi
SNHR	Sankhai
SNHT	Sanhati
SNI	Sindi
SNIE	Sath Naraini
SNJL	Sanjali
SNJN	New Sanjali
SNK	Sindkheda
SNKB	Sonkhamb
SNKE	Sunehti Kharkhr
SNKG	Sankaragummanur Halt
SNKL	Sankarankovil
SNKN	Sunakhani
SNKP	Sankhalpur
SNKR	Sanka
SNKX	Sankra P. H.
SNL	Sanahwal
SNLR	Santalpur
SNM	Sitanagaram
SNMR	Soniyana Mewar Halt
SNMY	Sindri Marshalling Y
SNN	Sonegaon
SNNR	Sindhanur
SNO	Somanur
SNP	Sonipat
SNPH	Shankapur Halt
SNPR	Singarpur
SNPU	Sonepur
SNQ	Sankarpur
SNR	Shyamnagar
SNRA	Sanwara
SNRD	Sandhurst Road
SNRL	Sansartali
SNRP	Sonipur Rupal (Halt)
SNRR	Sansarpur
SNS	Sasni
SNSI	Sainagar Shirdi
SNSL	Sonshelu
SNSM	S. N. Sundasrson & Company Sdg. Mehgaon
SNSN	Sonasan
SNSR	Sanosara (Nandra)
SNSY	Sanosari
SNT	Sainthia
SNTD	Santaldih
SNTH	Sonthaliya
SNTL	Sanathal
SNTP	NTPC Ltd. Siding (pvt/Bg), Salakati
SNTR	Shantinagar Halt
SNU	Sangrampur
SNV	Sondad
SNVL	Sonavali
SNVR	Sanvatsar
SNX	Saneh Road
SNYN	Soniana
SNZ	Sherganj
SO	Chennai Salt Cotaurs
SOA	Sanosara
SOAE	Somra Bazar
SOB	Silanibari
SOBK	Kiruburu Old Bunkar of M/S. SAIL
SOCM	M/S. Singareni Collieries Ltd (open Cast Mines) Siding
SOD	Sojat Road
SOE	Sheopur Kalan
SOF	Saota
SOFG	Ordinance Factory Siding, Shankerpally
SOG	Suratgarh Jn
SOGR	Sagra
SOH	Sirohi Road
SOHL	Sohal
SOI	Sonaripur
SOJ	Sarojini Nagar
SOJN	Sihor Gujarat
SOL	Solan
SOLA	Sovabazar-Ahiritola
SOLR	Solur
SOM	Somna
SONA	Sonamukhi PH
SONH	Seonan Halt
SONI	Soni
SONR	Saoner Jn
SONU	Sonu
SONW	Sonwarsa Halt
SOP	Shiupur
SOPR	Sonma Pranpur (Halt)
SOQ	Sompur Road
SOR	Sonagir
SORD	Sur Road
SORI	Sorai
SORO	Soro
SOS	Somesar
SOT	Shohratgarh
SOU	Supaul Jn
SOW	Sohsarai
SOY	Sukrimangela
SOZ	Soladi
SP	Saidapet
SPAC	Singapur Road A Cabin
SPAK	Arniya Kalan Salempura
SPAM	Senji Panambakkam
SPB	Sonekpur Halt
SPBC	Spgcl Block Cabin
SPBG	Sipra Bridge
SPBK	Sunderpur (barah Kalan)
SPC	Sitapur City
SPCC	Shambhupura 'c' Cabin
SPCR	Shibpurchar
SPD	Supedi
SPDA	Sapda
SPDM	Singhpur Dumra
SPDR	Sheoparsad Nagar
SPDS	Lucknow Supply Depot Lko
SPE	Sullurupeta
SPES	Sheikhpura Public Siding (Extension)
SPF	Stuartpuram
SPGL	Sarai Gopal
SPGN	Sripuriagaon
SPGR	Sampige Road
SPHL	Shampurhalli
SPJ	Samastipur Jn
SPJB	Saidpur Jalalabad Ha
SPJT	Salal Project Siding, Jat
SPK	Sapekhati
SPL	Sundaraperumalkoil
SPLE	Sujnipara
SPMG	Sirpur Paper Mills Ltd
SPN	Shahjahanpur Jn
SPNG	GCT Multi-Model Cargo Terminal of Shirpur Power Pvt Ltd. From Nardana
SPO	Surpura
SPP	Shahpur Patoree
SPPA	Sherpur Dhipura
SPPR	Shudnipur
SPPS	Printing Press Rly SDG
SPQ	Sorupeta
SPR	Sonarpur Jn
SPRA	Sillipur
SPRD	Singapur Road (Sprd)
SPRG	Security Paper Mills Siding, Hoshangabad@
SPRM	Sitapuram
SPRN	Salempur Halt
SPS	Shripat Shrkhnd
SPSG	Struttpit Colliery
SPSR	Sreejhadeswar PH
SPT	Sompeta
SPTR	Silapathar
SPUS	Spur Line No. II
SPV	Sivapur
SPVM	Sarpavaram
SPWI	Solapurwadi
SPX	Sapatgram
SPXS	Spur X 2nd Goods Shed
SPY	Sarsonpuri
SPYA	Sipaya
SPZ	Sampla
SQB	Singhabad
SQD	Sattirakkudi
SQE	Samrla
SQF	Sukritipur
SQJ	Saila Khurd
SQK	Shankar
SQL	Sontalai
SQN	Sarai Kansrai
SQQ	Salagaon
SQR	Sultanpur Lodi
SQS	Sigsigi
SQW	Sidhwalia
SQZ	Vanchangiri
SR	Sabli Road
SRA	Semra
SRAS	Siras
SRB	Sarobag
SRBA	Saragbundia
SRBH	Shaheed Ramphal Balhara Halt
SRBK	SAIL Rites Bengal Wagon Industry Pvt Ltd
SRBR	Surbari
SRBS	M/S Jai Balaji Industries Ltd
SRBZ	Sehara Bazar PH
SRC	Santragachi Jn
SRDA	Saradiya
SRDH	Sarsadh
SRDR	Sardarshahr
SRDW	Shrimad Dwkpuri
SRE	Saharanpur Jn
SREN	New Saharanpur
SREW	M/S. Hindusthan Engineering & Industries Ltd.
SRF	Sagar Jambagaru
SRGD	Saragaon Deori
SRGH	Surajgarh
SRGM	Srirangam
SRGP	Saragipali
SRGR	Saraygarh Jn
SRGT	Surendranagar G
SRHA	Sukhpar (roha )
SRHT	Sorkhi
SRI	Salmari
SRID	Sridham
SRJ	Shankargarh
SRJK	Suraj Kunda
SRJM	Sirjam
SRJN	Sirajnagar
SRJR	Sarsa Jamalpur
SRK	Samrau
SRKI	Semarkheri
SRKN	Sherekan
SRKR	Salarkhurd
SRKT	Sarkantra
SRL	Sarola
SRM	Sarna
SRMN	Semraon
SRMP	Sirsi Mukhdumpr
SRMR	Srirampuram
SRMT	Sirmuttra
SRNK	Soron Shukar Kshetra
SRNM	Sriramanagar Grama Halt
SRNR	Sriramnagar
SRNT	Sarnath
SRO	Sirathu
SRP	Serampore
SRPB	Srirampur Assam
SRPD	New Swarupganj
SRPJ	Swarupganj
SRPM	Siripuram
SRPN	Sripani
SRPR	Sarupsar Jn
SRPU	Sripur Halt
SRR	Shoranur Jn
SRRA	Shoranur A Cabin
SRRB	Shoranur 'b' Cabin
SRRG	Surergoth
SRSI	Sarsi
SRSL	Sirsala
SRSO	Sarsoo
SRT	Satur
SRTA	Sorta
SRTE	Soorothee
SRTL	Cherthala
SRTN	Sibsagar Town
SRU	Salempur Jn
SRUR	Sirpur Town
SRVA	Shirva
SRVN	Sravanur
SRVT	Siruvattur
SRVX	Suravali (H)
SRW	Shri Karanpur
SRWN	Saraswati Nagar
SRX	Sura Nussi
SRY	Sirari
SRZ	Sardargarh
SS	Shirsoli
SSA	Sirsa
SSAP	Selected Samla Asstt SDG
SSAS	Southern Structurals Siding
SSB	Shakurbasti
SSC	Shahi
SSCC	Sjk Steel Corporation Ltd
SSCK	Sijua Stabling Colliery SDG
SSCR	Sscr
SSCS	Shivpoor Shunting Neck CCL Siding
SSD	Shamsabad
SSDT	Shamshabad Town
SSF	Sirsuphal
SSG	Shiu Sagar Road
SSGJ	Sursaraighat Jhara
SSGM	Sarsogram
SSGR	Sisai Gulabrai Halt
SSGS	Sakrigali Sawai Goods Line
SSHT	Saghar Sutanpur
SSI	Shirsai
SSIA	Suisa
SSIB	Shrisai Block Cabin
SSIP	Bajaj Hindustan Ltd SDG (MG)
SSKA	Sisarka
SSKI	Sarsoki
SSKL	Suskal
SSL	Sirsaul
SSLM	Sri Santh Sevalal Maharaj Railway Crossing Station
SSM	Sasaram
SSMK	Iron Ore Deposite At Meghataburu
SSMN	Spur Siding
SSMS	Simbholi Sugar Mills Siding
SSMT	Silo Spur Siding of M/S Acb (India) Talcher Washery Private Limited
SSN	Sason
SSNH	Shri Sharada Nagar
SSNR	Satsang Nagar Halt
SSNS	Shaeed Suraj Naryan Singh
SSNT	Sirsa Nunthar Halt
SSP	Santoshpur
SSPD	Sadashivapet Road
SSPH	Satish Samanta P. H.
SSPL	Shyam Sel & Power Ltd/Tapasi
SSPN	Sai P Nilayam
SSPR	Sadashibapur
SSPS	Salem Steel Plant Sdg, Salem
SSR	Sareri
SSRD	Shasan Road
SSRH	Shasan Halt
SSTI	South Siding,tirodi
SSTP	Singarouli Super Thermal Power Siding of NTPC
SSU	Sasa Musa
SSV	Sasvad Road
SSW	Sarsawa
SSYS	SAIL SDG Janai Road
SSZ	Sadda Singhwala
ST	Surat
STA	Satna
STAR	M/S Star Cement Siding,(pvt/Bg) At Tetelia
STB	Shantipur
STBB	Satberia H
STBD	Sultanabad
STBJ	Sitabinj
STC	Santa Cruz
STCM	Singareni Thermal Power Plant of M/S. Sccl Ltd
STD	Satrod
STDB	Sitafalmandi B
STDI	Sitafalmandi A Cabin
STDR	Satadhar
STDV	M/S Ntpc's Simhadri Thermal Power Station
STE	Sagarkatte
STF	Sikta
STH	Sethal
STHL	Sinthal
STHM	Singareni Thermal Power Plant Track Hopper Served By Mci
STJT	Sathajagat
STKT	Sasthankotta
STKW	Sultanpur Kaliawas H
STL	Simultala
STLA	STLA Station
STLB	Sitalapur PH
STLI	Sithouli
STLIA	STLIA Station
STLR	Sitalpur
STM	St. Thomas Mount
STMM	St. Thomas Mount
STN	Sitarampur
STNC	Sitarampur Link Cabin
STNL	Satnali
STNR	Sitalnagar
STP	Sitapur Jn
STPB	Suratgarh Thermal Pwr SDG
STPD	Sitafal Mandi
STPS	Santaldih Thermal Power Station
STPT	Sitampet
STR	Satara
STRB	Santir Bazar
STRK	Sitapur Kuthcery HAL
STRM	Sitaramapuram
STSN	Shaitansinghanagar
STUR	Satulur
STVA	Satyavada
STW	Sahatwar
STZ	Satraon
SU	Surapur
SUA	Sardiha
SUAL	Saundal (H)
SUBL	Hubballi South (Hubli)
SUBR	Subhagpur
SUC	Sunak
SUCH	Suchindram
SUD	Sudhani
SUDL	Sripur No2 Colliery SDG
SUDR	Sunderpur Halt
SUDV	Summadevi
SUH	Sulehalli
SUHW	Sulehalli West
SUI	Sui
SUIA	Suraincha Halt
SUJ	Sarju
SUJH	Sujangarh
SUJR	Sujra
SUK	Sukhpur
SUKP	Sukhpar
SUKU	Suku
SUL	Suldhal
SULH	Sulhani
SUM	Summit
SUMA	Solu Majra Halt
SUMR	Sumer
SUND	Sundarna
SUNE	Surendranagar 'e' Cabin
SUNM	Sunamai Halt
SUNN	Surendranagar R. R.i
SUNR	Surendranagar
SUNW	Surendranagar West Cabin
SUP	Shrungavarpukta
SUPP	Suppalapadu
SUPR	Surajpur
SUR	Solapur Jn
SURI	Siuri
SURL	Sureli
SURP	Suratpura
SURR	Surera
SURX	Solapur Yard
SUT	Sutlana
SUU	Sulur Road
SUW	Sukhisewaniyan
SUX	Sudiyur
SUZ	Subansiri
SV	Siwan Jn
SVA	Suwasra
SVB	Savni
SVC	Siwan Kachari
SVD	Sarwari
SVDC	Sivadevunichikkala
SVDK	Shri Mata Vaishno Devi Katra
SVE	Sewri
SVER	M/S. Shri Vajra Enterprizes Pvt. Ltd.
SVF	Sri Venkata Perumal Raju Puram
SVG	Sawalgi
SVGA	Sivaganga
SVGL	Shribagilu
SVH	Sonadanga
SVHE	Sisvinhalli
SVI	Sagarpali
SVJ	Sajiyavadar
SVJR	Shivaji Nagar
SVK	Sivarakottai
SVKD	Savarkundla
SVKS	Sivakasi
SVL	Sevaliya
SVLI	Savli
SVM	Sanvordem (Kudchade)
SVMS	M/S. S.v. Multi Logi-Tech Pvt Ltd., Svd By Skp Rly Station
SVN	Sivungaon
SVNI	Sivni
SVNR	Savanur
SVO	Sanvrad
SVPH	Shivpur Halt
SVPI	Shivpuri
SVPM	Sri Venkateswarapalem
SVPO	Shivpoor
SVPR	Srivilliputtur
SVQ	Sivok
SVR	Sevvapet Road
SVRP	Shivanarayanpur
SVS	Srinivaspur
SVT	Shivpura
SVTN	Shivathan
SVU	Shivrajpur
SVUR	Sevur
SVV	Srivaikuntam
SVW	Shivni Shivapur
SVX	Sawarda
SVZ	Sarai Harkhu
SW	Sehra Mau
SW02	Kalgurki .h
SWA	Sahjanwa
SWAR	Sewar
SWC	Shivrampur
SWCR	Simen Chapari Halt
SWD	Sanawad
SWDE	Siwaha
SWDK	Seawoods Darave Karave
SWDV	Seawoodsdarave
SWE	Siwaith
SWF	Sathin Road
SWG	Sidhwan
SWI	Swamimalai
SWIG	Star Wire India Ltd Siding
SWJ	Siajuli
SWKE	Sawalkote
SWKT	Shewkaran (Belbaid) Colly. SDG
SWLN	Surwadi
SWM	Sawai Madhopur Jn
SWNI	Siwani
SWNR	Sewa Nagar
SWO	Sonwara
SWPR	Sewapuri
SWPS	Swami Paramhans (Bani)
SWQ	Sangwi
SWR	Sonua
SWRT	Sahawar Town
SWS	Suwansa
SWSR	Sangidalam West Sdg. Rjl
SWSS	Sudamdih Washery
SWT	Shivwala Tehu
SWU	Sanaura
SWV	Sawantwadi Road
SWW	Shahnagar Tmns
SWX	Saidanwala
SXA	Sagphata
SXB	Sambre
SXC	Sondalia
SXD	Siduli
SXE	Sila Kheri Halt
SXF	Sobhapur
SXH	Shingatgeri
SXK	Shajahanpurcort
SXN	Sonakhan
SXO	Srikona
SXP	Sankopara
SXQ	Suaheri
SXR	Serndanur
SXS	Shobhasan
SXT	Salem Town
SXX	Salbari
SXZM	Sopore
SY	Sirkazhi
SYA	Salaia
SYAE	Liluah Sorting Yard Cabin
SYC	Sarai Chandi
SYE	Sindewahi
SYF	Semai
SYH	Saiyedpur Bhtri
SYI	Singareni Collieries
SYJ	Saidraja
SYK	Saidkhanpur
SYL	Salpura
SYM	Savalyapuram
SYN	Sayan
SYO	Siroliya
SYQ	Sinhan
SYU	Sarayan
SYW	Sindurwa
SYWN	Saiyid Sarawan
SYZ	Sonai
SZ	Salawas
SZA	Sarotra Road
SZB	Sarona Cabin
SZE	Sonardih
SZF	Satbahini
SZH	Saonga Halt
SZK	Sur Khand ka Khera
SZM	Subzi Mandi
SZN	Shahbaznagar
SZP	Shahjahanpur
SZR	Sarupathar
SZV	Sivadi
SZY	Silak Jhori
SZZ	Sabira
TA	Tanur
TAA	Tadla Pusapalli
TABU	Talaburu
TAC	Taticherla
TADA	Tada
TAE	Tadali
TAK	Tarakeswar
TAKL	Takal
TAKU	Taku
TALA	Tala
TALL	Tall Jn
TAM	Tillaivilagam
TAN	Tarana Road
TAO	Tamna
TAP	Tapang
TAPA	Tapa
TAPG	Turbhe Apm Complex
TAR	Tharsa
TAS	Thasra
TASA	Thippasandra
TAST	Tori Siding
TAT	Tummanamgutta
TATA	Tatanagar Jn
TATI	Tati
TAUN	New Tauru
TAV	Talala Jn
TAY	Talaiyuthu
TAZ	Targaon
TB	Tharbitia
TBA	Timba Road
TBAE	Tribeni
TBAN	Timba Road Jn
TBB	Tilbhita
TBD	Telibandha P. H.
TBDM	Tungabhadra Dam
TBH	Tatibahar
TBL	Tarcherra Brlrm
TBM	Tambaram
TBMS	Tambaram Sanatorium
TBN	Timarni
TBR	Taiabpur
TBSE	Thankurani Bara Jamda
TBT	Talbahat
TBTN	Thana Bhawan Tn
TBU	Tharban
TBV	Timbarva
TBX	Tilbhum
TCH	Tiruchchuli
TCL	Tyakal
TCLD	The Pvt Sdg. of M/S. Indorama India Ltd.
TCLS	Tata Chemicals Ltd. -Mitapur
TCN	Tiruchendur
TCNR	Tiruchanur
TCR	Thrisur
TCS	Tisco Siding S/B Csdr
TCSB	Termi Siding (dhori Ii)
TCT	Ottankadu
TD	Tanda
TDD	Tadepalligudem
TDE	Thudiyalur
TDH	Tindharia
TDK	Taduku
TDL	Tundla Jn
TDLE	Tildanga
TDLN	New Tundla Jn
TDMS	Tuglakabad Mineral Goods Siding
TDN	Tiruparankundram
TDO	Tanda Urmar
TDOK	Taroki
TDP	Todarpur
TDPM	Todikkapulam Halt
TDPR	Tiruppadiripuliyur
TDPS	Tehri Hydro Dev Co Siding, Rishikesh
TDR	Tiruvidalmarudr
TDRD	Tanda Road
TDRP	Thein Dam Siding (ranjit Sagar)
TDU	Tandur
TDV	Thondebhavi
TDW	Tandwal
TEA	Taregna
TEG	Tirbediganj
TEK	Tekkali PH
TEL	Tenali Jn
TELI	Teli
TELO	Telo
TELY	Telia
TEMP	Mettur Thermal Power Plant Siding, Mettur Dam
TEN	Tirunelveli Jn
TENI	Teni
TEO	Teegaon
TEP	Tempa P. H.
TER	Thair
TERH	Terha Halt
TET	Tetulmari
TETA	Telta
TFAH	Trade Fair Authority Rly Sdng
TFGN	Tufanganj
TFMB	Ferro Manganese Plant of M/S. Tisco, Banspan
TGA	Teghra
TGB	Tangrabasuli Bs
TGBP	Thingou
TGCH	Teragachh
TGDE	Thangundi
TGE	Thekeraguri
TGG	Tiger Hill
TGH	Titagarh
TGL	Tuggali
TGLN	Taradgaon
TGM	Tangarmunda
TGN	Talegaon
TGP	Tuljapur
TGQ	Tenganmada
TGR1	Block & Catch Siding Cabin 1
TGR2	Block & Catch Siding Cabin 2
TGR3	Block & Catch Siding Cabin 3
TGRA	Tangaria
TGRL	Tangiri Apal
TGT	Tinai Ghat
TGU	Tarigoppula
TH	Tinich
THA	Tehta
THAL	Thal
THAN	Than Jn
THB	Thana Bihpur Jn
THBN	Thana Bhawan
THCN	Tirath
THDR	Thandla Road
THE	Thawe Jn
THEA	Thalera
THED	Tauheed
THJ	Talheri Buzurg
THJN	New Talheri Buzurg
THK	Thakurli
THKU	Thalaku
THL	Tiruvalam
THM	Thaiyat Hamira
THMA	Tham
THMR	Thathana Mithri
THN	Tolahunse
THO	Tulin
THP	Taherpur
THPR	Tippapur
THR	Thara
THS	Thansit
THSA	Thanisandra
THSG	Satpura Thermal Power Siding
THTW	Thailik Twisa
THUR	Thuria
THV	Therubali
THVM	Thivim
THW	Tharwai
THWM	Tapeshwarnath Dham (Fursatganj)
THX	Tovalai
THY	Thadi
TI	Tiruninravur
TIA	Tilaya
TIBI	Tibi
TIC	Timmachipuram
TICD	Inland Container Depot Tuglakabad
TICS	India Cement Siding
TID	Tagdi
TIG	Titlagarh
TIGJ	Triveniganj
TIHI	Tihi
TIHU	Tihu
TII	Tingrai
TIK	Tik
TIL	Tilrath
TILA	Tila
TIM	Timmanacherla
TIP	Tattapparai
TIR	Tirur
TIS	Tatisilwai
TISI	Tisi
TISJ	Tata Iron & Steel Unit 2 Siding
TISL	Tata Iron & Steel Unit 1
TISM	Tata Iron and Steel Co. Siding
TISR	Tata Iron & Steel Co Ltd Siding
TIST	Tata Iron & Steel Ltd Siding, Tkd
TIT	Talit
TIU	Tilaru
TIW	Tivari
TJ	Thanjavur Jn
TJD	Tajpur Dehma
TJH	Tajgadh
TJM	Turinjapuram
TJP	Tajpur
TJPS	Taljhari Public Siding
TJSP	Taj Sultanpur
TJW	Tejpurwa Halt
TK	Tumkur
TKA	Teharka
TKB	Tupkadih
TKBG	Teka Bigha
TKBN	Tsakibanda
TKC	Thakurkuchi
TKD	Tuglakabad
TKDC	Tuglakabad Jn Cabin
TKE	Tarikere Jn
TKEC	Tuglakabad East Cabin
TKF	Taki Road
TKFS	Food Corporation of India Sdg,tikoti
TKG	Thakurganj
TKGD	GCT-M/s Thdc India Ltd. Kstpp Siding Served By Danwar (Dar)
TKH	Thakurtota
TKHA	Takha
TKHE	Takarkhede
TKI	Takli
TKJ	Tilak Bridge
TKLB	Takli Bhansali
TKLE	Tikani
TKLN	Tarra Kalan
TKMG	Tikamgarh
TKMY	Taklimiya
TKN	Tankuppa
TKND	Trivikramdeo Nagar
TKNG	Tilaknagar
TKNR	Thakurnagar
TKO	Takkolam
TKOT	Tokkottu
TKP	Takipur
TKPH	Takipur Halt
TKPL	Tikirapal Halt
TKPY	Turkapalli H
TKQ	Trikarpur
TKR	Takari
TKRA	Tikra PH
TKRI	Tikiri
TKRP	Tikauli Rawatpr
TKRU	Takhrau
TKS	Tokisud
TKSS	Technolex Kalika Stone Supply and King and Co. Siding.
TKT	Tikkotti
TKTB	Thakurbari
TKU	Tanakallu
TKUR	Tappa Khajuria
TKV	Tek Newas
TKVR	Teknewas
TKW	Thakurvadi
TKWA	Tilakwada
TKWD	Tikekarwadi
TKYR	Tikaria
TL	Tiloniya
TLA	Titwala
TLAM	Tulsi Ashram
TLB	Telwa Bazar Halt
TLC	Talchhapar
TLD	Tilda
TLE	Talgaria
TLEW	TLEW Station
TLG	Tolly Ganj
TLGAN	Talegaon
TLGI	Teligi
TLGP	Talguppa
TLGR	Tulsi Nagar
TLH	Tilhar
TLHD	Talcher Road
TLHR	Talcher
TLI	Talwara Jhil
TLJ	Taljhari
TLKH	Talakhajuri
TLKL	Talakal
TLL	Talap
TLM	Tirusulam
TLMD	Trilochan Mahdo
TLMG	Talamagudi
TLMR	Teliamura
TLN	Talni
TLNH	Tilaunchi
TLNR	Talanallur
TLO	Talandu
TLPH	Talpur Halt
TLPR	Telapur
TLR	Tulsipur
TLRA	Talara
TLS	Bettahalsoor
TLSI	Tulsia
TLT	Tilati
TLTM	Ttps Siding Talcher
TLU	Tarlupadu
TLV	Talvadya Jn
TLWA	Thalwara
TLX	Taldi
TLY	Thalassery
TLZ	Talavli
TMA	Tamuria
TMB	Temburu
TMBY	Trombay
TMC	Talamanchi
TMD	Talmadla
TME	Tuti Melur
TMGN	Thamla Mogana
TMGP	Private Siding of M/S Tata Steel Limited
TMH	Tin Mile Hat
TMHA	Thumha
TMKA	Tomka
TML	Tenmalai
TMLP	Tirumalpur
TMLU	Tummalacheruvu
TMO	Tamlor
TMP	Tamaraipadi
TMPM	Timmapuram
TMPT	Tirumalairayan Pattinam H
TMPY	Tumboli
TMQ	Tirumangalam
TMR	Tumsar Road
TMS	Tumsar Town P. H.
TMST	Tingrai Military Siding (pvt/Bg), Tingrai
TMT	Timtala
TMU	Tirumanthikunam
TMUR	Tenua Dumaria Halt
TMV	Tindivanam
TMVL	Tirumullaivayil
TMX	Timmapur
TMZ	Tamluk
TMZJ	Tamluk Jn Cabin
TN	Tuticorin
TNA	Thane
TNBP	Toranagallu Byepass Cabin
TNDE	Thanesar City
TNDN	Thandoni
TNFS	Madras Fertilizer Ltd Siding
TNGI	Tungi Halt
TNGL	Toranagallu
TNGM	Tondalagpavaram
TNGN	Tangani
TNGR	Thonganur
TNH	Tinkheda
TNI	Tandarai
TNJE	Tentulla
TNJR	Taj Nagar
TNK	Tirunellikaval
TNKA	Tankhala
TNKU	Tanuku
TNL	Tangla
TNLR	Thondaimanallur
TNM	Tiruvannamalai
TNNH	Tapaswinarayan Nagar Halt
TNO	Tundu
TNP	Tondiarpet
TNPA	Madras Petrochemicals Ltd
TNPM	Tondiarpet Marshalling Yard
TNPR	Tejnarayanpur
TNPS	Indian Oil Corporation (b. G.) Siding No. 1
TNR	Tanguturu
TNRI	Teneri Halt
TNRU	Tenneru
TNT	Tinnappatti
TNU	Tirunettur
TNUE	Tindauli
TNW	Thapar Nagar
TNX	Tarak Nagar
TO	Tiruvalangadu
TOB	Tetonbari
TOD	Talod
TOI	Tamkuhi Road
TOK	Thokur
TOM	Tondamanpatti
TOP	Tapasi
TOR	Titur P. H.
TORA	Torniya
TORI	Tori
TOS	Tolasampatti
TOU	Telaprolu
TOY	Topputurai
TP	Tiruchchirappalli Fort
TPAK	Thermal Power Station Siding For Apgenco
TPAP	Ptpp Siding
TPAR	Thermal B Power House
TPB	Trilokpur
TPC	Tiruppachetti
TPDH	Tupadih
TPE	Tiruchrpli Plki
TPF	Tarapith Road
TPG	Tipling
TPGY	Tiruchchirappalli Goods
TPH	Tinpahar Jn
TPHG	Tata Power House Siding
TPHS	Thermal Power House Siding-Ukaisongadh
TPJ	Tiruchchirappalli Jn
TPK	Tipkai
TPKR	Tikiapara
TPM	Totiyapalayam
TPN	Tapona
TPND	Taloja Panchand
TPNI	Tulyapani
TPNR	Transport Nagar
TPO	Tantpur
TPP	Toppur
TPPI	Tipparthi
TPQ	Tokopal
TPSA	Top Sarthua
TPSK	M/S. Bharat Aluminium Co Ltd Siding
TPSM	Thermal Power Station Siding Kanti
TPST	Tori Public Siding
TPT	Tirupattur Jn
TPTN	Tiruchrpali Twn
TPTY	Tirupati
TPU	Tanakpur
TPV	Tinpheria
TPW	Tirupati W Hlt
TPY	Tadakalpudi
TPZ	Tapri
TPZN	New Tapri
TQA	Takia
TQL	Theh Qalandar
TQM	Telam
TQN	Tiqunia
TQR	Tektar
TR	Tarur
TRA	Tangra
TRAH	Taranga Hill
TRAN	Torang
TRB	Tiruverumbur
TRBE	Tarabari
TRBI	Taraboi PH
TRDI	Tirodi
TRE	Tikri
TRF	Taropa
TRG	Tarighat
TRGR	Targhar
TRJ	Tariasujan
TRK	Tirukkovilur
TRKR	Turekala Road
TRL	Tiruvallur
TRM	Tirunagesvaram
TRMN	Tharamani
TRN	Taraon
TRNA	Torna
TRNL	Tirunelveli Jn Cabin
TRO	Tirora
TRP	Tarapur Jn
TRPB	Tata Refractory Plant Siding
TRPL	Tripal Halt
TRR	Taraori
TRS	Tarsarai
TRSR	Tarsai
TRT	Tiruttani
TRTR	Tripunittura
TRTS	Tribeni Tissue SDG . For Itc Ltd. , Tribeni
TRV	Tarva
TRVL	Tiruvalla
TRVZ	Tiruvizha
TRW	Tarsod
TRWT	Taravata
TRX	Tirumani
TRZ	Tolra
TS	Tirap Siding Pvt (BG)
TSA	Tisua
TSAH	Tatasigua
TSD	Tahsil Bhadra
TSF	Tahsil Fatehpur
TSG	Sitapur City Thomsanganj Sdg.
TSI	Tenkasi Jn
TSIM	Private Siding of M/S Tata Steel Limited
TSK	Tinsukia Jn
TSKG	Tinsukia Goods
TSL	Taksal
TSLE	Tikok Siding
TSLJ	Private Siding of M/S Tata Steel Limited
TSLN	Tsl Siding Naini
TSM	Traisamadh
TSPD	M/S Tisco Dolomite
TSPT	Transport Siding, Ambala Cantt
TSR	Tsunduru
TSS	Talli Saidasahu
TSWS	Wanakbori Thermal Powerstation
TT	Titte
TTB	Titabar
TTGR	M/S Telangana Super Thermal Power Project Phase I
TTI	Turtipar
TTL	Tiruttangal
TTLA	Tetelia
TTMS	Tube Mill Project, Tatanagar Jn
TTN	Tulsitanr
TTO	Tarn Taran
TTP	Tiruturaipundi Jn
TTPD	Tenughat Thermal Power Station Siding
TTPH	Tanda Thermal Power House
TTPS	Tata Thermal Power Station Siding
TTPT	Talcher Thermal PH
TTQ	Thathankulam
TTR	Tiptur
TTRA	Tintoda
TTU	Tettu
TTW	Titwa
TTZ	Tukaithad
TU	Tadipatri
TUA	Tirunnavaya
TUD	Talodhi Road
TUG	Thalangai
TUH	Turbhe
TUHD	Thurandahalli
TUJ	Tanijan
TUL	Tiraldih
TULI	Tuli
TUM	Tulsigam
TUN	Tohana
TUNG	Tung
TUNI	Tuni
TUP	Tiruppur
TUR	Turki
TUV	Tuvvur
TUVR	Turavur
TUWA	Tuwa
TUX	Tunia
TUY	Thiruthuraiyur
TV	Ten Talav
TVC	Thiruvananthapuram Central
TVCN	Thiruvananthapuram North (Kochuveli)
TVCS	Thiruvananthapuram South (Nemom)
TVG	Tavargatti
TVI	Taradevi
TVL	Tadwal
TVN	Tiruppuvanam
TVNL	Tiruvennainallur Road
TVP	Thiruvananthapuram Pettah
TVR	Thiruvarur Jn
TVS	Talaivasal
TVSG	Rashtriya Chemicals and Fertilizers Siding-Thal Vaishett
TVT	Tiruvottiyur
TVTN	Tambavati Nagari
TWB	Talwandi
TWG	Twining Ganj
TWI	Totewahi Halt
TWL	Tilwara
TWLB	Titagarh Wagons Limited,bharatpur
TWS	Tisco Works Site
TWV	Thuwavi
TXD	Tyada
TXM	Tandavapura
TXOT	Aoc Siding Tinsukia (A) (BG)
TXR	Thirunallaru
TY	Tulukapati
TYAE	Tenya
TYK	Thabalke
TYM	Tirumayam
TYMR	Tiruvanmiyur
TYSG	The Ramco Cements Ltd SDG/Tulukapatti
TYT	Tirunelveli Twn
TZD	Tozhuppedu
TZH	Takazhi
TZR	Turki Road
TZTB	Tezpur
UA	Upleta
UAA	Uppala
UAL	Upariyala
UAM	Udagamandalam
UAR	Unawa Aithor
UARL	M/S Unipro Agroinfra Rohtak Pvt Ltd Gati Shakti M Modal Cargo Termi
UB	Uska Bazar
UBC	Ambala City
UBCD	New Ambala City
UBCN	Ulhas Bridge Cabin
UBL	SSS Hubballi Jn
UBLS	Hubballi Shops
UBN	Ubarni
UBR	Umbargam Road
UBRN	New Umbergaon Road
UCA	Uchana
UCB	Unchi Bassi
UCGK	M/S Udaipur Cement Works Ltd. Gati Shakti Multi Modal Cargo Terminal
UCH	Unchaulia
UCLB	M/S Ultra Tech Cement Grinding Unit Siding
UCLC	M/S. Ultratech Cement Limited
UCLG	Ultra Tech Cement Ltd
UCLH	Ultratech Cement Ltd
UCLJ	Ultra Tech Cement Ltd
UCLM	Ultratech Cement Limited,unit:maihar Cement Works
UCLS	Ultra Tech Cement Ltd.
UCLT	Ultra Tech Cement Ltd. Turki Served By Turki Road (Tzr)
UCP	Uchippuli
UCPD	Ultra Tech Cement Ltd.:unit Patliputra Cement Works
UCR	Unchahar Jn
UCRJ	Unchahar Jn Cabin
UCSD	Ultratrech Cemco Ltd
UCSM	GCT of M/S Ultratech Cement Limited
UCTV	M/S. Ultra Tech Cement Ltd. Gati Shakti Cargo Terminal
UD	Udupi
UDGR	Udgir
UDK	Udyan Kheri
UDKL	Udai Kalan
UDKN	Udaiyapur Khurd
UDL	Andal Jn
UDLE	Andal-East/cabin
UDLU	Andal Up
UDLW	Andal West Cabin
UDM	Undasa Madhawpu
UDMR	Udi Mor Jn
UDN	Udhna Jn
UDNN	New Udhna
UDPR	Udaipura
UDPU	Udaipur
UDR	Amdara
UDS	Udasar
UDT	Udumalaippettai
UDX	Urdauli
UDZ	Udaipur City
UEPF	Uri Civil Siding
UGD	Uppugunduru
UGN	Ugaon
UGNA	Ugna Halt
UGNC	Ujjain 'c' Cabin
UGNR	Udyognagar PH
UGP	Ugarpur
UGR	Ugar Khurd
UGSM	Upper Ganges Sugar Mills
UGSU	Uslapur Public Siding
UGU	Ugu
UGWE	Ugwe
UHL	Una Himachal
UHP	Udhampur
UHR	Unchhera
UIH	Umaria Ispa Hlt
UJ	Ujalvav
UJA	Unjha
UJH	Ujhani
UJN	Ujjain Jn
UJNC	Ujjain Cbo
UJP	Ujiarpur
UKA	Ukhra
UKC	Ukshi
UKD	Ulindakonda
UKE	Uttarkathani
UKEC	Urkura East Cabin
UKH	Ukhali
UKL	Uttukuli
UKLR	Ukilerhat Halt
UKN	Uklana
UKR	Udalkachhar
UKV	Uttamarkovil
UKWC	Urkura West Cabin
ULA	Umra Nala
ULB	Ulubaria
ULCE	Kulti Sdg. Kulti
ULD	Achalda
ULDN	New Achalda
ULG	Udalguri
ULL	Ullal
ULM	Urlam
ULN	Ulna Bhari
ULNR	Ulhasnagar
ULR	Ultadanga Road
ULT	Kulti
ULTL	Kulti Link Cabin
ULU	Ulundurpet
UM	Umardashi
UMB	Ambala Cantt Jn
UMBY	Ambala Cantt Yard
UMD	Usmanabad
UME	Taqa Neyveli Power Company Pvt Ltd SDG S/By Uttangalmangalam
UMED	Umed
UMG	Uttangal Mangalam
UMH	Umreth
UML	Umalla
UMLS	Private Siding of M/S Tata Steel Limited
UMM	Umram
UMN	Ambliyasan
UMND	New Umardashi
UMNM	Ambliyasan
UMNR	Umeshnagar
UMPD	Umarpada
UMR	Umaria
UMRA	Umra
UMRI	Umri
UMS	Udramsar
UMSG	Umred Colliery Siding
UMYD	Marshalling Yard
UNA	Una
UNCB	M/S Ultra Tech Nathdwara Cement Ltd
UNCK	M/S Ultra Tech Nathdwara Cement Ltd
UNCT	Uran City
UND	Unchdih
UNDI	Undi
UNDN	New Unchdih
UNGU	Udhna New Goods Shed
UNI	Unai Vansada Road
UNK	Unkal
UNL	Unhel
UNLA	Unaula
UOI	Umroli
UPA	Uttarpara
UPCL	Upcl Siding Served By Nandikoor
UPD	Ulavapadu
UPDP	Up Departure Yard Served By Ddu
UPI	Uplai
UPL	Uppalur
UPM	Urappakkam
UPR	Usmanpur
UPRD	Usmanpur Dehat Halt
UPSG	U. P. State Electricity Board Siding Paricha
UPW	Uppalavai
UR	Umdanagar
URAN	Uran
URD	Untare Road
UREN	Uren
URG	Usargaon
URGA	Urga
URGR	Udayagiri Ratnagiri Road
URI	Uruli
URK	Urkura
URL	Unjalur
URMA	Urma
URML	Upramal
URN	Utran
URP	Udairampur
URPR	Ugrasenpur
URR	Umred
URT	Umrala
USD	Ukai Songadh
USK	Usia Khas
USL	Uslapur
USLP	Usilampatti
USRA	Usra
UTA	Umar Tali
UTCB	M/S. Ultratech Cement Ltd. (unit: Baikunth Cement Works)
UTCG	M/S. Ultratech Cement Limited Unit:manikgarh Cement Works
UTCH	M/S Ultra Tech Cement Ltd.
UTCJ	Ultra Tech Cement Ltd Jharli
UTCK	M/S Ultra Tech Cement Limited (unit Birla Whi
UTCM	M/S. Ultra Tech Cement Limited (unit:rajashree Cement Works)
UTCR	M/S. Ultra Tech Cement Limited,unit: Balaji Cement Works Served By Rrpm
UTCS	M/S. Ultra Tech Cement Limited (unit:shankarpally Bulk Tmnl)
UTCU	M/S Ultratech Cement Siding
UTD	Utarsanda
UTL	Utarlai
UTN	Uttar Radhanagar Halt
UTP	Utripura
UTR	Utrahtia
UVD	Udvada
UVSN	Unawa Vasan
UWAN	Urwan
UWNR	Udwant Nagar Halt
VAA	Bhaga Jn
VAD	Velavadar
VADR	Warud
VAE	Vadali
VAH	Valluru Halt
VAJ	Vadapalanji Halt
VAK	Varkala
VAL	Vadal
VAN	Vadhvana
VAPI	Vapi
VAPM	Valapattanam
VAR	Vidyanagar
VARD	Vaikam Road
VAS	Vasai Dabhla
VASG	HPCL ,gail/Vijaypur
VASO	Vaso
VAT	Vatlur
VAU	Vadarlapadu
VAY	Vayalar
VB	Villiyambakkam
VBC	Vijaywada Bulb
VBCG	Ultra Tech Cement Ltd.
VBH	Vishnupur Bathua Halt
VBL	Bobbili
VBN	Vallabhnagar
VBR	Vambori
VBU	Vembur
VBW	Vaibhavwadi Road
VC	Vyasa Colony
VCA	Vinchiya
VCHT	Voc Port-Hare Island Coal Terminal Pvt Siding
VCN	Virochannagar
VCSG	M/S. Cement Division Unit of Kesoram Industries Ltd, (Vcsg)
VCSN	Ultratech Cement Siding - Jawad Road and Nimbahera
VCSV	Virar Carshed
VCT	Victor
VD	Vagdiya
VDA	Vasad Jn
VDAN	New Vasad
VDD	Vendodu
VDE	Vedayapalem
VDG	Vadnagar
VDGN	Vadgaon
VDGT	Vadala Granthin
VDH	Vedchha
VDI	Veldurti
VDK	Vadakannikapurm
VDKS	Vadanam Kurushshi Ha
VDL	Vaithisvarankoil
VDLR	Vadala Road
VDM	Vadamadura
VDN	Vadgaon
VDNP	Baijnath Andoli
VDP	Vadippatti
VDPD	Vadlapudi
VDR	Vandalur
VDS	Vidyasagar
VDV	Vadiya Devli
VDY	Vedaranniyam
VED	Verad
VEER	Veer
VEI	Velliyanai
VEK	Vellarakkad
VEL	Vellanur
VELI	Veli
VEM	Vempalli
VEML	Vemula
VEN	Verna
VEPH	Geb Thermal Power SDG - Utran
VER	Vellur Halt
VEU	Veppampattu
VG	Viramgam Jn
VGA	Vepagunta
VGDC	Viramgam D Cabin
VGE	Valappadi G Hlt
VGH	Velangi
VGI	Vangni
VGL	Vaghli
VGLB	Virangana Lakshmibai Jn
VGLJ	Veerangana Lakshmibai Jhansi
VGM	Vinnamangalam
VGN	Vangaon
VGP	Veganpur
VGRA	Vagra
VGSD	Vizag General Cargo Berth Pvt. Ltd. Siding
VGT	Unguturu
VH	Vakada
VHGN	Wihirgaon
VHK	VHK Station
VHL	Wahiyal
VI	Villianur
VID	Vilavade
VIGB	M/S Vimla Infra (India) Pvt. Ltd. Gati Shakti Multi Modal Cargo Terminal
VIKU	Vellikallu
VINA	Vina
VINH	Vinhere
VIPN	M/S. Vimla Infrastructure (India) Pvt Ltd, Svd By Nasp Rly Stn
VIPS	M/S Vidharbha Inustries Power Ltd
VIR	Welspun Maxsteel.
VIRUD	Virudasampatty
VIS	Viswesraya Iron and Steel
VJ	Virinchipuram
VJA	Vejandla
VJD	Vijpadi Road
VJF	Vijapur
VJK	Vejalka
VJM	Vyasarpadi Jeeva
VJP	Vijaypur
VJPJ	Vijiypur Jammu
VJR	Vijayanagar
VJRD	Vajirabad
VK	Vikhroli
VKA	Verka Jn
VKB	Vikarabad Jn
VKD	Bakhrabad
VKDH	Veer Kunwar Singh Dharauli Halt
VKG	Vavadi Khurd
VKH	Vikhran
VKI	Venkatagiri
VKL	Vankal
VKM	Venkatesapuram
VKN	Vinukonda
VKNR	Valmikinagar Road
VKP	Varakalpattu
VKR	Venkatnagar
VKT	Venkatachalam
VKZ	Venkatanarasimharajuvaripeta
VL	Vilad
VLA	Bavla
VLC	Velachha
VLCY	Velacherry
VLD	Vayalpad
VLDE	Valadi
VLDI	Vithalwadi
VLDR	Valadar
VLE	Vellalcheruvu Halt
VLG	Valligonda
VLI	Vallikunnu
VLK	Villivakkam
VLL	Vellayil
VLN	Vilegaon
VLNK	Velankanni
VLP	Vile Parle
VLR	Vellore Cantonment
VLSY	V S Lad & Sons
VLT	Valathoor
VLTR	Vadali Luter Road
VLU	Vadalur
VLV	Vallivedu
VLX	Taqa Neyveli Power Company Pvt Ltd Siding S/By Vadalur
VLY	Valliyur
VLYN	Vallabh Vdyangr
VM	Villupuram Jn
VMA	Vikramgarh Alot
VMD	Vadlamannadu
VML	Vemulapadu
VMLD	Vemuluripadu
VMM	Valaramanikkam
VMP	Vallampadugai
VMR	Vemar
VMU	Vemuru
VN	Vaniyambadi
VNA	Varangaon
VNB	Vaniyambalam
VNC	Vijayawada North Cabin
VNCW	Vishakaptnam New Goods Complex
VND	Vendra
VNE	Vishwanath Chariali
VNEC	Vijayawada North East
VNG	Visnagar
VNGL	Vangal
VNGP	Vangaichungpao
VNJ	Vanjipalaiyam
VNK	Binaiki
VNKA	Vankiya
VNL	Velanandal
VNM	Ontimitta
VNN	Bhanaur
VNP	Venpura
VNPN	Vain Puin
VNR	Devanur
VNRD	Vani Road
VNT	Vyankatpura
VNTD	Vantada (Viravada)
VNUP	Vishnupuram
VNWI	Vighanwadi
VO	Vellodu
VOC	Voc Nagar
VOL	Virol
VONB	Vondh
VOSG	Hindustan Petroleum Corporation Siding
VP	Virapur
VPCD	M/S Vaman Prestress Co. Digsar
VPDA	Vidyapatidham
VPDM	Vallarpadam
VPDP	International Container Transhipment Terminal Siding
VPG	Ventrapragada
VPH	Vachaspatinagar
VPJ	Vaiyampatti
VPL	Venkatampalle
VPMS	Vishakapatnam Port Manual Iron Ore Unloading Siding
VPN	Vidyapatinagar
VPO	Bhupia Mau
VPR	Visapur
VPT	Virudunagar Jn
VPTG	Vishakaptnam Port Tippler Iron Ore Unloading Siding
VPU	Velpuru
VPUN	Velpuru North
VPY	Vyasarpadi
VPZ	Vallapuzha
VQD	Viramdad
VR	Virar
VRA	Valavanur
VRB	Vishrambag
VRBD	Vrindaban Road
VRDP	Varadapura
VRE	Varediya
VREN	New Varediya
VRG	Vikramnagar
VRH	Virbhadra
VRI	Vriddhachalam Jn
VRJ	Vadaj
VRJN	Venkatachalam Road Jn
VRK	Virkudi
VRKD	Varkhedi
VRL	Veraval
VRLB	Veraval Docks
VRLI	Veravali
VRLR	Virani Alur
VRM	Varnama
VRN	Vanganur
VRO	Vaidi Road
VRPD	Virapandy Road
VRQ	Virarakkiyam
VRQS	Chettinad Cement Corporation Private Ltd SDG
VRR	Virpur
VRS	Virsad
VRSS	M/S. Vrc Silos Pvt. Ltd.
VRT	Vriddhachalm Tn
VRU	Valiveru
VRV	Viravada Halt
VRVL	Veeravalli
VRX	Varahi
VS	Vishvamitri Jn
VSD	Vasind
VSG	Vasco da Gama
VSH	Vashi
VSHI	Vaishali
VSI	Vishvamitri Jn
VSKP	Visakhapatnam
VSM	Valsura Military Sdg, Jamnagar
VSP	Wasanapura
VSPG	Vishakapattanam Steel Project Sdg.
VSPR	Bishnupriya
VSPS	Visakhapatnam Steel Plant Siding
VSPT	Visakapatnam Steel Plant Siding
VSPV	M/S Vizag Sea Port Pvt Ltd
VSR	Vasundhara Halt on Barhan-Etah branch line
VSRD	Vasai Thirth Road
VST	Bijaysota
VSTP	Vindhyachal Super Thermal Power SDG of NTPC
VSU	Bishnupur
VSV	Vasadva
VSW	Visavadar
VSYV	Virar Scrap Yard
VT	Vellore Town
VTA	Vatva
VTAK	Vatva Kheri
VTAS	Vatva Diesel Shed
VTDI	Varetha
VTE	Venkatagirikote Halt
VTG	Bhetaguri
VTJ	Vartej
VTK	Vallathol Nagar
VTL	Vadtal Swaminarayan
VTM	Vetapalemu
VTN	Vaitarana
VTP	Vastrapur
VTV	Valantaraval
VU	Vaghpura
VUL	Virul
VV	Valivade
VVA	Varvala
VVB	Viveka Vihar
VVD	Vavdi
VVG	V. V.giri Halt
VVH	Vidyavihar
VVKN	Vivekananda Nagar
VVKP	Vivekanand Puri Halt
VVL	Vadviyala
VVM	Viravasaram
VVN	Vikravandi
VVR	Viravanallur
VVV	Vavera
VWA	Viduraswattha
VWLR	M/S. Vedanta Washery and Logistc Solutions Pvt. Ltd./Rob
VWP	Vishwanath Puri
VXD	Vadod
VXM	Vellpapalyam
VY	Vatva Yard
VYA	Vyara
VYK	Vilayatkalan Road
VYN	Vyasnagar
VYS	Vyasanakeri
VZ	Vijayamangalam
VZM	Vizianagram Jn
VZP	Visakhapatnam Port
VZPB	Vishakapatnam Port B Siding (IOC) Vpt
VZPF	FCI Siding No. 1. Vishakaptanam Port
VZPG	Visakapatnam Port Nfg (FCI) Siding No. 2 Vpt
VZPH	Vazeerpur Halt
VZPS	SAIL Siding Vishakaptnam Port
VZPW	Visakhapatnam Wcsfg Siding
VZPZ	M/S. Hindustan Zinc Ltd. Siding
VZR	Bhanjpur
WAAD	Wayad
WAB	Balwa
WACS	Malabar Cement Sdg, Walayar
WAD	Wadali
WADI	Wadi Jn
WADO	Wadoda
WAIR	Wair
WANI	Wani
WAT	Visakhapatnam Electric Loco Shed
WB	Wadi Bandar
WBCC	West Bokaro Colliery SDG
WBPC	West Bengal Power Development Corporation Ltd Siding At Pakur
WC	Wadhwan City
WCB	West Cabin Gaya
WCF	Western Coal Fields Ltd Siding
WCGS	M/S Wonder Cement Ltd. Gati Shakti Multi Modal Cargo Terminal Sonu
WCLS	M/S Wonder Cement Ltd. Siding Served By Somna
WCMB	M/S Wonder Cement Ltd Siding Mohanbari
WCN	Wimco Nagar
WCNA	M/S. Wonder Cement Ltd. Gati Shakti Terminal (gct)- Nardana
WCPS	West Coast Paper Mills Ltd
WCSG	Wonder Cement Siding
WCST	GCT M/S Wonder Cement Ltd-Timba Road
WDA	Wadrengdisa
WDC	Wadi Chord Cabin
WDD	West Dn Dept Cabin
WDG	Wadegaon
WDHR	Wadharva
WDJ	Wanderjatana
WDL	Wandal
WDLN	Wadwal Nagnath
WDM	Wyndhamganj
WDN	Vadgaon Nila
WDR	Wadiaram
WDS	Wadsinge
WDSG	ACC SDG
WDSX	Associate Cement Co. Ltd. Sdg, Wadi Jn Yard (Txr)
WEL	Wellington
WENA	Wena
WFCS	FCI Siding Whitefield
WFD	Whitefield
WG	Wagholi
WGA	Waghoda
WGCR	Wrs Public Siding
WGI	Waghai
WGJ	Waris Ganj (Halt)
WGN	Waghaniya
WGR	Waghoriya
WH	West Hill
WHG	Food Corporation of India Grain Godown S
WHIS	IOC & Gwalior Rayon Silk Mfg & Weaving Co. Ltd SDG
WHM	Washim
WHPC	Whitefield Panel Cabin
WIRR	Wirur
WJ	Walajabad
WJML	Waverly Jute Mills (asstd ) SDG Knr
WJMS	Wellington Jute Mill SDG ., Rishra
WJP	Vejpur
WJR	Walajah Road
WKA	Vakav
WKAC	Wankaner A Cabin
WKI	Wadakancheri
WKND	Wanawar Koteshwarnath Dham
WKR	Wankaner Jn
WKRC	Wankaner City
WL	Warangal
WLA	Valtoha
WLGC	Walgaon Outer Cabin
WLGN	Walgaon
WLH	Valha
WML	Windmill
WMP	Vishrampura
WND	Wan Road
WNG	Wanegaon
WNGS	Wani New Goods Shed
WOC	Warud Orange City
WP	Wangapalli
WPA	West Port Siding
WPR	Wanparti Road
WR	Wardha Jn
WRA	Walayar
WRC	Wrs Colony
WRD	Warudkhed
WRGN	Warigaon Newada
WRI	Waraseoni
WRR	Warora
WRS	Waris Aleganj
WSA	Wadsa
WSB	Washimbe
WSC	West Side Cabin Tundla
WSD	Wasud
WSE	Vasan Iyawa
WSJ	Wansjaliya
WSR	Wa-Sojintra Halt
WST	Washermanpet
WTJ	Jam Wanthali
WTP	Water Pipe
WTR	Wathar
WTS	Sorath Vanthali
WTWI	Wetalwadi
WW	Wanabar Halt
WWA	Vavaniya
WYCW	Wani Yard Colliery Siding
WZJ	Wazerganj
X101	Tgr Cabin No 1
X102	X102 Station
X103	X103 Station
X108	Aman Lodge
XBAC	Bachharpur Halt
XBKJ	Bikramganj
XCBN	XCBN Station
XGN	Gokulnagar Halt
XSAD	Sadipur Halt
XSAN	Sarvodaya Halt
XSK	Sokali
Y	Yeliyur
Y1	Y1 Station
YA	Yerraguntla
YAD	Yeulkhed
YADA	Yadavalli
YADD	Yadadri
YAG	Yaqutganj
YAL	Yataluru
YDD	Yadudih
YDK	Yedekumeri
YDLP	Yadalapur
YDM	Yedamangala
YDP	Yedapalli
YDV	Yadvendranagar
YEAM	Yogendra Dham Halt
YFIB	M/S Yara Fertilizers India Pvt. Ltd.
YFP	Yusufpur
YG	Yadgir
YGA	Yerra Goppa Halt
YGD	Yerragudipadu
YGL	Yelgur
YGM	Yadugram Bh
YJUD	Yamunanagar Jagadhri
YKA	Yakutpura
YL	Yeola
YLBA	Yelburga
YLG	Yalvigi
YLK	Yellakaru
YLM	Elamanchili
YLSC	Y-Leg Connection Cabin
YNA	Yenor
YNG	Yenugonda
YNK	Yelahanka Jn
YNKS	Kptcl Gas Turbine Plant
YNRK	Yog Nagari Rishikesh
YP	Errupalem
YPD	Yerpedu
YPR	Yesvantpur Jn
YPRA	Yesvantpur A Cabin
YS	Yermaras
YSI	Yedshi
YSPM	Yasantapur
YT	Yevat
YTG	Yeshwantnagar
YTL	Yavatmal
YTPY	M/S Yermaras Thermal Power Station
YVP	Yawarpura
YY	Yediyuru
YYNGPI	Itwari Bypass Cabin
ZAR	Jharola
ZARP	Zarap
ZB	Zahirabad
ZBD	Zafarabad Jn
ZCS	Zuari Industries Ltd
ZCT	Zuari Cement Ltd
ZKV	Zankhvav
ZL	Indopak Border
ZN	Jangaon
ZNA	Zamania
ZNP	Zindpura
ZP	Zerpur Pali
ZPI	Zampani Halt
ZPL	Zangalapalle
ZPR	Zorawar Pura Halt
ZR	Jhajhpor
ZRDE	Jiradei
ZUBA	Zubza
ZW	Zawar`;

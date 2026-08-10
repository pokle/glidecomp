# S7F 2020–2022 PG weights

S7F 2020–2022 PG weight generation (AirScore history import). A third
`leadingWeightFormula` value 's7f2020' implements the PWC-derived PG
weights of the S7F 2020–2022 editions (AirScore's gap2020/gap2021/
gap2022 presets): distance weight fixed at 0.838 when nobody makes
goal, else 0.805 − 1.374·GR + 1.413·GR² − 0.484·GR³; leading weight
fixed at 0.162 (LeadingTimeRatio ignored); arrival 0; time the
remainder (exactly 0 at goal ratio 0). Never a default — selected
explicitly in settings or by the AirScore formula importer — so no
existing comp's scores move; the guard fires on the added branch.

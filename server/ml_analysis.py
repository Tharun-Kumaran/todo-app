import os
import json
import numpy as np
import pandas as pd
from datetime import datetime

from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier, RandomForestRegressor, HistGradientBoostingRegressor
from sklearn.dummy import DummyClassifier
from sklearn.metrics import (
    roc_auc_score,
    average_precision_score,
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    confusion_matrix,
    classification_report,
    mean_squared_error,
    mean_absolute_error,
    r2_score
)

def run():
    csv_path = 'server/data/dataset.csv'
    df = pd.read_csv(csv_path)

    # Clean date columns
    date_cols = ['Task Creation Date', 'Due Date', 'Date Shifted', 'Date Completed', 'Deadline', 'Actual Complete Date']
    for c in date_cols:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], format='%d-%m-%Y', errors='coerce')

    df['is_delayed'] = df['is_delayed'].astype(int)

    # Feature Engineering from Task Name
    df['action_verb'] = df['Task Name'].astype(str).apply(lambda x: x.split()[0] if len(x.split()) > 0 else 'Unknown')
    df['creation_dayofweek'] = df['Task Creation Date'].dt.day_name()
    df['creation_month'] = df['Task Creation Date'].dt.month_name()
    df['allocated_lead_days'] = pd.to_numeric(df['allocated_lead_days'], errors='coerce').fillna(0)
    df['actual_duration_days'] = pd.to_numeric(df['actual_duration_days'], errors='coerce').fillna(0)

    # =========================================================================
    # PART 1: EXPLORATORY DATA ANALYSIS (Statistical Associations)
    # =========================================================================
    eda = {}

    def get_agg(col):
        grp = df.groupby(col)['is_delayed'].agg(
            Total='count',
            Delayed='sum',
            Delay_Rate='mean'
        ).reset_index()
        grp['Delay_Rate_Pct'] = (grp['Delay_Rate'] * 100).round(1)
        return grp.sort_values(by='Delay_Rate', ascending=False).to_dict(orient='records')

    eda['priority'] = get_agg('Priority')
    eda['category'] = get_agg('Category')
    eda['action_verb'] = get_agg('action_verb')
    eda['is_repeated'] = get_agg('is_repeated')
    eda['repeated_task'] = get_agg('Repeated Task')
    eda['is_shifted'] = get_agg('is_shifted')
    eda['shift_reason'] = get_agg('Shift Reason')

    # Lead days statistics
    lead_stats = df.groupby('is_delayed')['allocated_lead_days'].agg(
        Mean='mean',
        Median='median',
        Std='std',
        Min='min',
        Max='max'
    ).round(2).reset_index().to_dict(orient='records')
    eda['lead_days_stats'] = lead_stats

    # Duration stats
    dur_stats = df.groupby('is_delayed')['actual_duration_days'].agg(
        Mean='mean',
        Median='median',
        Std='std',
        Min='min',
        Max='max'
    ).round(2).reset_index().to_dict(orient='records')
    eda['duration_stats'] = dur_stats

    print("EDA completed.")

    # =========================================================================
    # PART 2: MACHINE LEARNING MODELING FOR DELAY PREDICTION
    # =========================================================================
    cat_cols = ['Priority', 'Category', 'action_verb', 'is_repeated', 'Repeated Task', 'creation_dayofweek']
    num_cols = ['allocated_lead_days']

    # One-hot encode using get_dummies
    X_raw = df[cat_cols + num_cols].copy()
    X_dummies = pd.get_dummies(X_raw, columns=cat_cols, drop_first=True)
    y = df['is_delayed'].values

    X_train, X_test, y_train, y_test = train_test_split(
        X_dummies, y, test_size=0.20, random_state=42, stratify=y
    )

    models = {
        'Dummy (Baseline)': DummyClassifier(strategy='most_frequent'),
        'Logistic Regression': LogisticRegression(max_iter=1000, random_state=42, class_weight='balanced'),
        'Random Forest': RandomForestClassifier(n_estimators=150, max_depth=12, random_state=42, class_weight='balanced'),
        'HistGradientBoosting': HistGradientBoostingClassifier(max_iter=150, random_state=42, class_weight='balanced')
    }

    eval_results = {}
    for name, clf in models.items():
        clf.fit(X_train, y_train)
        y_pred = clf.predict(X_test)
        if hasattr(clf, 'predict_proba'):
            y_prob = clf.predict_proba(X_test)[:, 1]
            auc = roc_auc_score(y_test, y_prob)
            pr_auc = average_precision_score(y_test, y_prob)
        else:
            y_prob = [0] * len(y_test)
            auc = 0.5
            pr_auc = float(np.mean(y_test))

        cm = confusion_matrix(y_test, y_pred).tolist()
        eval_results[name] = {
            'Accuracy': round(float(accuracy_score(y_test, y_pred)), 4),
            'Precision': round(float(precision_score(y_test, y_pred, zero_division=0)), 4),
            'Recall': round(float(recall_score(y_test, y_pred, zero_division=0)), 4),
            'F1_Score': round(float(f1_score(y_test, y_pred, zero_division=0)), 4),
            'ROC_AUC': round(float(auc), 4),
            'PR_AUC': round(float(pr_auc), 4),
            'Confusion_Matrix': cm
        }
        print(f"[{name}] Acc: {eval_results[name]['Accuracy']}, F1: {eval_results[name]['F1_Score']}, AUC: {eval_results[name]['ROC_AUC']}")

    # Feature Importance from Logistic Regression
    lr_model = models['Logistic Regression']
    lr_coefs = pd.Series(lr_model.coef_[0], index=X_train.columns).sort_values(ascending=False)
    top_pos_features = lr_coefs.head(10).round(3).to_dict()
    top_neg_features = lr_coefs.tail(10).round(3).to_dict()

    # Feature Importance from Random Forest
    rf_model = models['Random Forest']
    rf_imp = pd.Series(rf_model.feature_importances_, index=X_train.columns).sort_values(ascending=False).head(10).round(4).to_dict()

    # In-Flight model (evaluating is_shifted & reasons)
    inflight_cat = cat_cols + ['Shift Reason']
    inflight_num = num_cols + ['is_shifted', 'shift_count', 'shift_days']
    X_if_raw = df[inflight_cat + inflight_num].copy()
    X_if_dummies = pd.get_dummies(X_if_raw, columns=inflight_cat, drop_first=True)
    X_tr_if, X_te_if, y_tr_if, y_te_if = train_test_split(
        X_if_dummies, y, test_size=0.20, random_state=42, stratify=y
    )
    rf_if = RandomForestClassifier(n_estimators=150, max_depth=12, random_state=42, class_weight='balanced')
    rf_if.fit(X_tr_if, y_tr_if)
    y_pred_if = rf_if.predict(X_te_if)
    y_prob_if = rf_if.predict_proba(X_te_if)[:, 1]

    eval_results['InFlight_Random_Forest'] = {
        'Accuracy': round(float(accuracy_score(y_te_if, y_pred_if)), 4),
        'Precision': round(float(precision_score(y_te_if, y_pred_if, zero_division=0)), 4),
        'Recall': round(float(recall_score(y_te_if, y_pred_if, zero_division=0)), 4),
        'F1_Score': round(float(f1_score(y_te_if, y_pred_if, zero_division=0)), 4),
        'ROC_AUC': round(float(roc_auc_score(y_te_if, y_prob_if)), 4),
        'PR_AUC': round(float(average_precision_score(y_te_if, y_prob_if)), 4),
        'Confusion_Matrix': confusion_matrix(y_te_if, y_pred_if).tolist()
    }

    # =========================================================================
    # PART 3: DURATION REGRESSION & DEADLINE RECOMMENDATION
    # =========================================================================
    y_dur = df['actual_duration_days'].values
    X_tr_reg, X_te_reg, y_tr_reg, y_te_reg = train_test_split(
        X_dummies, y_dur, test_size=0.20, random_state=42
    )

    regressor = HistGradientBoostingRegressor(max_iter=150, random_state=42)
    regressor.fit(X_tr_reg, y_tr_reg)
    y_pred_reg = regressor.predict(X_te_reg)

    reg_metrics = {
        'MAE_days': round(float(mean_absolute_error(y_te_reg, y_pred_reg)), 2),
        'RMSE_days': round(float(np.sqrt(mean_squared_error(y_te_reg, y_pred_reg))), 2),
        'R2_Score': round(float(r2_score(y_te_reg, y_pred_reg)), 4)
    }
    print(f"Regression Duration Model: {reg_metrics}")

    # Percentile duration benchmarks by Priority & Category
    benchmarks = df.groupby(['Priority', 'Category'])['actual_duration_days'].agg(
        Count='count',
        Median_Days='median',
        Mean_Days='mean',
        P75_Days=lambda x: np.percentile(x, 75),
        P90_Days=lambda x: np.percentile(x, 90)
    ).round(1).reset_index().to_dict(orient='records')

    # Generate concrete predictions & suggestions for 6 diverse sample tasks from dataset
    samples = df.sample(8, random_state=42)
    sample_outputs = []

    for _, row in samples.iterrows():
        # Build one-row dataframe matching X_dummies columns
        single_row = pd.DataFrame([row[cat_cols + num_cols]])
        single_dummies = pd.get_dummies(single_row, columns=cat_cols)
        single_aligned = single_dummies.reindex(columns=X_dummies.columns, fill_value=0)

        prob_delay = float(models['HistGradientBoosting'].predict_proba(single_aligned)[0, 1])
        predicted_duration = float(regressor.predict(single_aligned)[0])

        # Benchmark P80
        match = [b for b in benchmarks if b['Priority'] == row['Priority'] and b['Category'] == row['Category']]
        p90_duration = match[0]['P90_Days'] if match else predicted_duration * 1.3
        median_duration = match[0]['Median_Days'] if match else predicted_duration

        # Suggested lead days with safety margin
        suggested_lead_days = int(np.ceil(p90_duration))
        creation_date = row['Task Creation Date']
        suggested_deadline = creation_date + pd.Timedelta(days=suggested_lead_days)

        sample_outputs.append({
            'Task_ID': row['Task ID'],
            'Task_Name': row['Task Name'],
            'Category': row['Category'],
            'Priority': row['Priority'],
            'Creation_Date': creation_date.strftime('%d-%m-%Y'),
            'Original_Due_Date': row['Due Date'].strftime('%d-%m-%Y') if pd.notnull(row['Due Date']) else 'N/A',
            'Allocated_Lead_Days': int(row['allocated_lead_days']),
            'Actual_Duration_Days': int(row['actual_duration_days']),
            'Delay_Probability': round(prob_delay, 3),
            'Delay_Risk_Level': 'HIGH' if prob_delay > 0.55 else ('MEDIUM' if prob_delay > 0.25 else 'LOW'),
            'Predicted_Duration_Days': round(predicted_duration, 1),
            'Suggested_Lead_Days': suggested_lead_days,
            'Suggested_Deadline': suggested_deadline.strftime('%d-%m-%Y'),
            'Actually_Delayed': bool(row['is_delayed'] == 1),
            'Actual_Delay_Status': row['delay_status']
        })

    # Save to JSON
    final_output = {
        'total_tasks': len(df),
        'overall_delayed_count': int(df['is_delayed'].sum()),
        'overall_delayed_pct': round(float(df['is_delayed'].mean() * 100), 2),
        'eda': eda,
        'model_evaluations': eval_results,
        'logistic_regression_top_positive': top_pos_features,
        'logistic_regression_top_negative': top_neg_features,
        'random_forest_top_features': rf_imp,
        'duration_regression_metrics': reg_metrics,
        'sample_predictions_and_suggestions': sample_outputs
    }

    out_file = 'server/data/analysis_results.json'
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(final_output, f, indent=2)

    print(f"All results saved to {out_file}")

if __name__ == '__main__':
    run()
